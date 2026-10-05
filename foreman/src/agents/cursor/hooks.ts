// Permission bridge + project hooks for Cursor agents (canUseTool equivalent via hooks).
//
// Writes `.cursor/hooks.json` + a gate script into the agent's cwd. Hook scripts POST tool
// metadata to a local HTTP bridge; the bridge runs classifyToolUse and, for "ask", creates a
// permission decision and waits for the user.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyToolUse, describeRuleKey, describeToolCall } from '../../policy.js';
import type { Foreman } from '../../foreman.js';
import { PERMISSION_OPTIONS } from '../../protocol.js';
import { truncate } from '../../util/text.js';
import { userName } from '../../user.js';
import type { TurnHandle } from '../common/tool-handlers.js';
import { normalizeCursorToolName, normalizeToolInput } from './stream.js';

export interface BridgeTurn {
  agentId: string;
  role: 'lead' | 'worker';
  cwd: string;
  turn: TurnHandle;
  token: string;
}

interface GateRequest {
  token?: string;
  tool?: string;
  input?: Record<string, unknown>;
  command?: string;
  hookEvent?: string;
}

interface GateResponse {
  permission: 'allow' | 'deny' | 'ask';
  user_message?: string;
  agent_message?: string;
}

const GATE_SCRIPT = `#!/usr/bin/env node
// AgentCraft permission gate for Cursor hooks (generated; do not edit by hand).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 3_600_000 },
      (res) => {
        const out = [];
        res.on('data', (d) => out.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(out).toString('utf8') || '{}')); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('bridge timeout')); });
    req.write(data);
    req.end();
  });
}

(async () => {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
  const metaPath = path.join(__dirname, 'agentcraft-bridge.json');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* missing */ }
  const tool = payload.tool_name || payload.toolName || payload.tool || (payload.command ? 'Shell' : 'unknown');
  const input = payload.tool_input || payload.input || payload.args || {};
  if (payload.command && !input.command) input.command = payload.command;
  let res;
  try {
    res = await post(meta.url + '/gate', {
      token: meta.token,
      tool,
      input,
      command: payload.command,
      hookEvent: payload.hook_event_name || payload.hookEvent,
    });
  } catch (e) {
    res = { permission: 'deny', agent_message: 'AgentCraft permission bridge unreachable: ' + (e && e.message ? e.message : e) };
  }
  process.stdout.write(JSON.stringify(res));
})().catch((e) => {
  process.stdout.write(JSON.stringify({ permission: 'deny', agent_message: String(e && e.message ? e.message : e) }));
  process.exit(0);
});
`;

export class PermissionBridge {
  private server: http.Server | undefined;
  private port = 0;
  private turns = new Map<string, BridgeTurn>();

  constructor(private fm: Foreman) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.turns.clear();
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  register(turn: BridgeTurn): void {
    this.turns.set(turn.token, turn);
  }

  unregister(token: string): void {
    this.turns.delete(token);
  }

  /** Write project hooks into cwd so settingSources: ['project'] loads them. */
  installHooks(cwd: string, token: string): void {
    // Keep AgentCraft-managed Cursor files out of git (else worktree commits + main checkout
    // merge fights over untracked `.cursor/` / `.agentcraft/`).
    ensureGitExclude(cwd, ['.cursor/', '.agentcraft/']);
    const dir = path.join(cwd, '.cursor', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agentcraft-gate.cjs'), GATE_SCRIPT, 'utf8');
    fs.writeFileSync(path.join(dir, 'agentcraft-bridge.json'), JSON.stringify({ url: this.url, token }, null, 2), 'utf8');
    const hooksPath = path.join(cwd, '.cursor', 'hooks.json');
    const hookEntry = { command: 'node .cursor/hooks/agentcraft-gate.cjs', failClosed: true };
    let existing: { version?: number; hooks?: Record<string, unknown[]> } = { version: 1, hooks: {} };
    try {
      if (fs.existsSync(hooksPath)) existing = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as typeof existing;
    } catch {
      /* replace broken config */
    }
    existing.version = 1;
    existing.hooks ??= {};
    // Replace our previous entries; keep unrelated hooks if present
    const filterOurs = (list: unknown[] | undefined) =>
      (list ?? []).filter((h) => !(h && typeof h === 'object' && 'command' in h && String((h as { command: string }).command).includes('agentcraft-gate')));
    existing.hooks.beforeShellExecution = [...filterOurs(existing.hooks.beforeShellExecution), hookEntry];
    existing.hooks.preToolUse = [...filterOurs(existing.hooks.preToolUse), hookEntry];
    fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2), 'utf8');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'POST' && req.url === '/gate') {
      const body = await readBody(req);
      let payload: GateRequest = {};
      try {
        payload = JSON.parse(body || '{}') as GateRequest;
      } catch {
        payload = {};
      }
      const out = await this.gate(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  }

  private async gate(req: GateRequest): Promise<GateResponse> {
    const turn = req.token ? this.turns.get(req.token) : undefined;
    if (!turn) return { permission: 'deny', agent_message: 'Unknown or expired AgentCraft turn token.' };
    if (turn.turn.signal.aborted) {
      return { permission: 'deny', agent_message: `Your turn was stopped by ${userName()}.` };
    }

    const rawName = String(req.tool ?? (req.command ? 'Shell' : 'unknown'));
    // Our custom tools skip interactive approval in the SDK; still allow if a hook fires.
    if (/^(send_message|ask_user|write_memory|read_memory|update_task|report_status|list_tasks|create_task|request_merge)$/.test(rawName)) {
      return { permission: 'allow' };
    }
    if (rawName.includes('custom-user-tools') || rawName.startsWith('MCP:')) {
      const leaf = rawName.includes('__') ? rawName.split('__').pop()! : rawName.replace(/^MCP:/, '');
      if (/^(send_message|ask_user|write_memory|read_memory|update_task|report_status|list_tasks|create_task|request_merge)$/.test(leaf)) {
        return { permission: 'allow' };
      }
    }

    const toolName = normalizeCursorToolName(rawName);
    const input = normalizeToolInput(toolName, (req.input ?? {}) as Record<string, unknown>, req.command);
    const verdict = classifyToolUse(toolName, input, {
      role: turn.role,
      cwd: turn.cwd,
      readDirs: [this.fm.memory.dir],
      alwaysAllow: this.fm.store.data.permissionRules[turn.agentId] ?? [],
      mcpServer: 'agentcraft',
    });

    if (verdict.action === 'allow') return { permission: 'allow' };
    if (verdict.action === 'deny') {
      this.fm.agentLog(turn.agentId, 'error', `blocked: ${describeToolCall(toolName, input)} (${verdict.reason})`);
      return { permission: 'deny', agent_message: verdict.reason };
    }

    // ask: create a decision and wait (hook blocks until we respond)
    const prev = this.fm.agent(turn.agentId);
    const prevState = prev ? { state: prev.state, station: prev.station, activity: prev.activity } : undefined;
    const t = prev?.taskId;
    const d = this.fm.createDecision({
      agentId: turn.agentId,
      kind: 'permission',
      tool: toolName,
      question: `${this.fm.nameOf(turn.agentId)} wants to run ${truncate(describeToolCall(toolName, input), 160)}`,
      options: [...PERMISSION_OPTIONS],
      context: `${verdict.reason}\ncwd: ${turn.cwd}\n"${PERMISSION_OPTIONS[1]}" covers: ${[...new Set(verdict.ruleKeys.map(describeRuleKey))].join('; ')}`,
      ...(t ? { taskId: t } : {}),
    });
    this.fm.setAgent(turn.agentId, { state: 'waiting_user', station: 'user', activity: 'asking permission' });
    this.fm.agentLog(turn.agentId, 'tool', `permission? ${describeToolCall(toolName, input)}`);
    const onAbort = () => this.fm.decisions.cancel(d.id, 'turn stopped');
    if (turn.turn.signal.aborted) onAbort();
    else turn.turn.signal.addEventListener('abort', onAbort, { once: true });
    const res = await this.fm.decisions.wait(d.id);
    turn.turn.signal.removeEventListener('abort', onAbort);
    if (turn.turn.signal.aborted) return { permission: 'deny', agent_message: 'The turn was stopped.' };
    if (prevState) this.fm.setAgent(turn.agentId, prevState);
    const opt = res.answer?.option;
    if (res.status === 'answered' && (opt === PERMISSION_OPTIONS[0] || opt === PERMISSION_OPTIONS[1])) {
      if (opt === PERMISSION_OPTIONS[1]) {
        const rules = (this.fm.store.data.permissionRules[turn.agentId] ??= []);
        for (const k of verdict.ruleKeys) if (!rules.includes(k)) rules.push(k);
        this.fm.store.markDirty();
      }
      this.fm.agentLog(turn.agentId, 'result', `${userName()} allowed: ${describeToolCall(toolName, input)}`);
      return { permission: 'allow' };
    }
    this.fm.agentLog(turn.agentId, 'error', `${res.status === 'cancelled' ? 'Permission request withdrawn' : `${userName()} denied`}: ${describeToolCall(toolName, input)}`);
    return {
      permission: 'deny',
      agent_message: `${userName()} denied this${res.answer?.text ? `: ${res.answer.text}` : ''}. Find another way or ask_user.`,
    };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function newHookToken(): string {
  return `ac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Append patterns to this checkout's `.git/info/exclude` (shared across worktrees). */
export function ensureGitExclude(cwd: string, patterns: string[]): void {
  let excludePath: string;
  try {
    const rel = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    excludePath = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
  } catch {
    return;
  }
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  let text = '';
  try {
    text = fs.readFileSync(excludePath, 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split(/\r?\n/);
  const missing = patterns.filter((p) => !lines.some((l) => l.trim() === p));
  if (!missing.length) return;
  const suffix = (text.endsWith('\n') || text.length === 0 ? '' : '\n') + missing.join('\n') + '\n';
  fs.appendFileSync(excludePath, suffix, 'utf8');
}
