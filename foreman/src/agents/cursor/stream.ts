// Map Cursor SDK stream messages -> agent.log entries + agent state/station.
import type { Foreman } from '../../foreman.js';
import { firstLine, headLines, tailLines, truncate } from '../../util/text.js';
import { relPath, toolActivity } from '../activity.js';
import type { CursorSDKMessage } from './types.js';

export interface TurnStats {
  sessionId?: string;
  resultText?: string;
  subtype?: string;
  isError: boolean;
  costUsd?: number;
  numTurns?: number;
  authFailed?: string;
  errors: string[];
}

const AUTH_RE = /(authentication|not logged in|log ?in|\/login|invalid api key|oauth|401|credential)/i;

/** Normalize Cursor tool names (Shell/shell/read/...) to Claude-style names activity.ts/policy expect. */
export function normalizeCursorToolName(name: string): string {
  const leaf = name.includes('__') ? name.split('__').pop()! : name.replace(/^MCP:/i, '');
  const key = leaf.trim();
  const map: Record<string, string> = {
    shell: 'Bash',
    Shell: 'Bash',
    bash: 'Bash',
    Bash: 'Bash',
    read: 'Read',
    Read: 'Read',
    write: 'Write',
    Write: 'Write',
    edit: 'Edit',
    Edit: 'Edit',
    delete: 'Write',
    Delete: 'Write',
    grep: 'Grep',
    Grep: 'Grep',
    glob: 'Glob',
    Glob: 'Glob',
    ls: 'LS',
    LS: 'LS',
    Ls: 'LS',
    webSearch: 'WebSearch',
    WebSearch: 'WebSearch',
    webFetch: 'WebFetch',
    WebFetch: 'WebFetch',
    task: 'Task',
    Task: 'Task',
    agent: 'Agent',
    Agent: 'Agent',
    TodoWrite: 'TodoWrite',
    todoWrite: 'TodoWrite',
  };
  if (map[key]) return map[key]!;
  // custom-user-tools MCP leaf names stay as-is for AgentCraft tools
  return key;
}

/** Coerce Cursor tool args into the shape policy/activity expect (e.g. Shell -> command). */
export function normalizeToolInput(toolName: string, input: Record<string, unknown>, command?: string): Record<string, unknown> {
  const out = { ...input };
  if (command && typeof out.command !== 'string') out.command = command;
  // Cursor edit/write sometimes use `path` instead of `file_path`
  if (typeof out.path === 'string' && typeof out.file_path !== 'string') out.file_path = out.path;
  if (toolName === 'Bash' && typeof out.command !== 'string' && typeof out.cmd === 'string') out.command = out.cmd;
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'text' in (content as object)) return String((content as { text: unknown }).text ?? '');
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content).slice(0, 2000);
  } catch {
    return String(content);
  }
}

function summarizeResult(tool: string, text: string): string {
  const name = normalizeCursorToolName(tool);
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
  switch (name) {
    case 'Read':
      return `${lines.length} lines`;
    case 'Grep':
    case 'Glob':
    case 'LS':
      return lines.length ? `${lines.length} results\n${headLines(lines.join('\n'), 4, 400)}` : 'no matches';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return firstLine(text, 160) || 'ok';
    case 'Bash':
    case 'PowerShell':
      return tailLines(text, 8, 900) || '(no output)';
    default:
      return headLines(text, 4, 500) || 'ok';
  }
}

function diffFromInput(tool: string, input: Record<string, unknown>, cwd: string): string | undefined {
  const name = normalizeCursorToolName(tool);
  const file = typeof input.file_path === 'string' ? relPath(input.file_path, cwd) : typeof input.path === 'string' ? relPath(input.path, cwd) : '?';
  const clip = (s: string, n: number) => s.replace(/\r\n/g, '\n').split('\n').slice(0, n);
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return [file, ...clip(input.old_string, 6).map((l) => `- ${l}`), ...clip(input.new_string, 8).map((l) => `+ ${l}`)].join('\n');
  }
  if (name === 'Write' && typeof input.content === 'string') {
    const all = input.content.split('\n');
    return [`${file} (${all.length} lines)`, ...clip(input.content, 10).map((l) => `+ ${l}`)].join('\n');
  }
  return undefined;
}

export class StreamMapper {
  private toolNames = new Map<string, string>();
  readonly stats: TurnStats = { isError: false, errors: [] };

  constructor(
    private fm: Foreman,
    private agentId: string,
    private cwd: string,
    private role: 'lead' | 'worker',
  ) {}

  handle(msg: CursorSDKMessage): void {
    const fm = this.fm;
    const id = this.agentId;
    switch (msg.type) {
      case 'system': {
        const m = msg as { subtype?: string; agent_id?: string; model?: { id?: string } | string };
        if (m.subtype === 'init' && m.agent_id) {
          this.stats.sessionId = m.agent_id;
          const model = typeof m.model === 'string' ? m.model : m.model?.id;
          fm.log.debug(`${id}: session ${m.agent_id} (${model ?? '?'})`);
        } else if (m.agent_id) {
          this.stats.sessionId ??= m.agent_id;
        }
        break;
      }
      case 'assistant': {
        const blocks = ((msg as { message?: { content?: unknown } }).message?.content ?? []) as Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
        for (const b of blocks) {
          if (b.type === 'text' && b.text?.trim()) {
            fm.agentLog(id, 'text', truncate(b.text.trim(), 1200));
            const a = fm.agent(id);
            if (a && a.state !== 'waiting_user') fm.setAgent(id, { state: 'thinking', activity: firstLine(b.text, 48) });
          } else if (b.type === 'tool_use' && b.name && b.id) {
            this.onToolStart(b.id, b.name, (b.input ?? {}) as Record<string, unknown>);
          }
        }
        break;
      }
      case 'thinking': {
        const text = (msg as { text?: string }).text;
        const a = fm.agent(id);
        if (a && a.state !== 'waiting_user') fm.setAgent(id, { state: 'thinking', activity: 'thinking' });
        if (text?.trim()) fm.agentLog(id, 'text', `~ ${truncate(text.trim().replace(/\s+/g, ' '), 300)}`);
        break;
      }
      case 'tool_call': {
        const m = msg as { call_id: string; name: string; status: string; args?: unknown; result?: unknown };
        if (m.status === 'running' || (!m.result && m.status !== 'completed' && m.status !== 'error')) {
          this.onToolStart(m.call_id, m.name, (m.args ?? {}) as Record<string, unknown>);
        } else {
          const tool = this.toolNames.get(m.call_id) ?? m.name;
          const text = resultText(m.result);
          const isError = m.status === 'error';
          const norm = normalizeCursorToolName(tool);
          const isCustom = /^(send_message|ask_user|write_memory|read_memory|update_task|report_status|list_tasks|create_task|request_merge)$/.test(norm);
          if (isCustom && !isError) fm.agentLog(id, 'result', headLines(text, 3, 300) || 'ok');
          else fm.agentLog(id, isError ? 'error' : 'result', isError ? truncate(text || 'tool error', 600) : summarizeResult(tool, text));
        }
        break;
      }
      case 'status': {
        const m = msg as { status?: string; message?: string };
        if (m.status === 'ERROR') {
          this.stats.isError = true;
          if (m.message) this.stats.errors.push(m.message);
          if (m.message && AUTH_RE.test(m.message)) this.stats.authFailed = firstLine(m.message, 200);
        } else if (m.status === 'CANCELLED') {
          this.stats.subtype = 'cancelled';
        } else if (m.status === 'FINISHED') {
          this.stats.subtype ??= 'success';
        }
        break;
      }
      case 'usage': {
        const u = (msg as { usage?: { totalCostUsd?: number; totalTokens?: number } }).usage;
        if (typeof u?.totalCostUsd === 'number') this.stats.costUsd = u.totalCostUsd;
        break;
      }
      case 'task': {
        const text = (msg as { text?: string }).text;
        if (text?.trim()) fm.agentLog(id, 'text', truncate(text.trim(), 400));
        break;
      }
      default:
        break;
    }
  }

  /** Apply terminal RunResult into stats after stream ends. */
  applyResult(result: { status: string; result?: string; usage?: { totalCostUsd?: number } }): void {
    this.stats.subtype = result.status === 'finished' ? 'success' : result.status;
    this.stats.isError = result.status === 'error';
    if (result.result) this.stats.resultText = result.result;
    if (typeof result.usage?.totalCostUsd === 'number') this.stats.costUsd = result.usage.totalCostUsd;
    if (result.status === 'error' && result.result) {
      this.stats.errors.push(result.result);
      if (AUTH_RE.test(result.result)) this.stats.authFailed = firstLine(result.result, 200);
    }
    const cost = typeof this.stats.costUsd === 'number' ? ` · $${this.stats.costUsd.toFixed(3)}` : '';
    this.fm.agentLog(
      this.agentId,
      this.stats.isError ? 'error' : 'result',
      `turn ${this.stats.isError ? `ended: ${result.status}` : 'complete'}${cost}`,
    );
  }

  private onToolStart(callId: string, name: string, rawInput: Record<string, unknown>): void {
    const tool = normalizeCursorToolName(name);
    this.toolNames.set(callId, tool);
    const input = normalizeToolInput(tool, rawInput);
    const act = toolActivity(tool, input, this.cwd);
    this.fm.agentLog(this.agentId, 'tool', act.label);
    const diff = diffFromInput(tool, input, this.cwd);
    if (diff) this.fm.agentLog(this.agentId, 'diff', diff);
    this.fm.setAgent(this.agentId, { state: act.state, station: act.station, activity: act.activity });
    if ((act.state === 'editing' || act.state === 'running' || act.state === 'testing') && this.role === 'worker') {
      const repoId = this.fm.agent(this.agentId)?.repoId;
      if (repoId) this.fm.repos.scheduleRefresh(repoId, 1500);
    }
  }
}
