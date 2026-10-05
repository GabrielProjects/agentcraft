// Orchestration test for the cursor backend with a scripted fake Agent.create/resume.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CursorBackend } from '../src/agents/cursor/index.js';
import { StreamMapper, normalizeCursorToolName } from '../src/agents/cursor/stream.js';
import { detectCursorAuth, NO_CURSOR_AUTH_MESSAGE } from '../src/agents/cursor/auth.js';
import type { CursorAgent, CursorAgentOptions, CursorRun, CursorSDKMessage } from '../src/agents/cursor/types.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const sid = (k: string) => `cursor-agent-${k.padStart(4, '0')}`;
let n = 0;

async function callCustom(opts: CursorAgentOptions, name: string, args: Record<string, unknown>): Promise<string> {
  const tool = opts.local.customTools?.[name];
  if (!tool) throw new Error(`missing custom tool ${name}`);
  const res = await tool.execute(args);
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object' && 'content' in res) {
    const c = (res as { content: Array<{ text?: string }> }).content;
    return c.map((x) => x.text ?? '').join('\n');
  }
  return JSON.stringify(res);
}

async function gateShell(cwd: string, command: string): Promise<string> {
  const metaPath = path.join(cwd, '.cursor', 'hooks', 'agentcraft-bridge.json');
  await until(() => fs.existsSync(metaPath), 5_000);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { url: string; token: string };
  const body = JSON.stringify({ token: meta.token, tool: 'Shell', input: { command }, command });
  return await new Promise((resolve, reject) => {
    const u = new URL(meta.url + '/gate');
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const calls: Array<{ prompt: string; cwd: string; resume?: string; env?: Record<string, string | undefined> }> = [];
let permissionVerdict: string | undefined;

function snapshotGitEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k === 'AGENTCRAFT_AGENT') out[k] = v;
  }
  return out;
}

function fakeCreate(h: Harness): (opts: CursorAgentOptions) => Promise<CursorAgent> {
  return async (opts) => {
    const agentId = sid(String(++n));
    return makeFakeAgent(h, opts, agentId);
  };
}

function fakeResume(h: Harness): (id: string, opts: CursorAgentOptions) => Promise<CursorAgent> {
  return async (id, opts) => makeFakeAgent(h, opts, id);
}

function makeFakeAgent(h: Harness, opts: CursorAgentOptions, agentId: string): CursorAgent {
  return {
    agentId,
    async send(prompt: string): Promise<CursorRun> {
      calls.push({ prompt, cwd: opts.local.cwd, env: snapshotGitEnv(), ...(agentId ? { resume: agentId } : {}) });
      const events: CursorSDKMessage[] = [];
      let cancelCalled = false;
      async function play(): Promise<void> {
        const p = prompt;
        const cwd = opts.local.cwd;
        if (p.startsWith('New goal')) {
          events.push({ type: 'system', subtype: 'init', agent_id: agentId, model: { id: 'fake' } });
          events.push({ type: 'tool_call', call_id: 'r1', name: 'read', status: 'running', args: { path: path.join(cwd, 'src', 'cli.ts') } });
          events.push({ type: 'tool_call', call_id: 'r1', name: 'read', status: 'completed', result: 'ok' });
          await callCustom(opts, 'write_memory', { title: 'Plan: --version flag', body: '# Plan\n- t1 flag (Kit)\n- t2 docs (Juniper)', scope: 'shared' });
          const a = await callCustom(opts, 'create_task', { title: 'Add a --version flag', description: 'print the package version', assignee: 'kit' });
          const id1 = /Created (t\d+)/.exec(a)![1]!;
          await callCustom(opts, 'create_task', { title: 'Document --version in README', description: 'one line', assignee: 'juniper', deps: [id1] });
          await callCustom(opts, 'send_message', { to: 'all', text: 'Plan is up.' });
          return;
        }
        const task = /Your task: (t\d+)/.exec(p)?.[1];
        if (task && cwd.includes('kit-')) {
          events.push({ type: 'system', subtype: 'init', agent_id: agentId });
          events.push({
            type: 'tool_call',
            call_id: 'e1',
            name: 'edit',
            status: 'running',
            args: { path: path.join(cwd, 'src', 'cli.ts'), old_string: "case 'help':", new_string: "case '--version':" },
          });
          const cli = path.join(cwd, 'src', 'cli.ts');
          fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace("      case 'help':", "      case '--version':\n        io.out('pocket-notes 0.2.0');\n        return 0;\n      case 'help':"));
          events.push({ type: 'tool_call', call_id: 'e1', name: 'edit', status: 'completed', result: 'updated' });
          const gate = JSON.parse(await gateShell(cwd, 'npm install left-pad')) as { permission: string };
          permissionVerdict = gate.permission === 'allow' ? 'allow' : 'deny';
          const answer = await callCustom(opts, 'ask_user', { question: 'Print just the number or "pocket-notes 0.2.0"?', options: ['Name + number (recommended)', 'Just the number'] });
          events.push({ type: 'assistant', message: { content: [{ type: 'text', text: `Got it: ${answer}` }] } });
          events.push({ type: 'tool_call', call_id: 'b1', name: 'shell', status: 'running', args: { command: 'npm test' } });
          events.push({ type: 'tool_call', call_id: 'b1', name: 'shell', status: 'completed', result: '# pass 10' });
          await callCustom(opts, 'update_task', { task_id: task, status: 'review', summary: 'Added --version; tests pass.' });
          return;
        }
        if (task && cwd.includes('juniper-')) {
          events.push({ type: 'system', subtype: 'init', agent_id: agentId });
          fs.appendFileSync(path.join(cwd, 'README.md'), '\n`notes --version` prints the version.\n');
          events.push({ type: 'tool_call', call_id: 'w1', name: 'write', status: 'running', args: { path: path.join(cwd, 'README.md'), content: 'x' } });
          events.push({ type: 'tool_call', call_id: 'w1', name: 'write', status: 'completed', result: 'ok' });
          return;
        }
        if (p.startsWith('You ended your turn')) {
          events.push({ type: 'system', subtype: 'init', agent_id: agentId });
          return;
        }
        const review = /Review request: (t\d+)/.exec(p)?.[1];
        if (review) {
          events.push({ type: 'system', subtype: 'init', agent_id: agentId });
          if (review === 't1') await callCustom(opts, 'request_merge', { task_id: review, summary: 'Adds --version. Tests green.' });
          return;
        }
        events.push({ type: 'system', subtype: 'init', agent_id: agentId });
      }

      const done = play();
      return {
        id: `run-${agentId}`,
        async *stream() {
          await done;
          for (const e of events) yield e;
        },
        async wait() {
          await done;
          return { status: 'finished', result: 'done', usage: { totalCostUsd: 0.01 } };
        },
        supports: (op) => op === 'cancel',
        async cancel() {
          cancelCalled = true;
          void cancelCalled;
        },
      };
    },
    async close() {},
  };
}

let h: Harness;
let home: string;
let repoPath: string;
let backend: CursorBackend;

beforeAll(async () => {
  home = tempDir();
  repoPath = await demoRepo();
  h = makeForeman(home, ['--backend', 'cursor', '--workers', 'kit,juniper', '--repo', repoPath]);
  backend = new CursorBackend(h.fm, h.cfg.cursor, {
    createAgent: fakeCreate(h),
    resumeAgent: fakeResume(h),
    skipAuthCheck: true,
  });
  await h.fm.start(backend);
});

afterAll(async () => {
  await h.fm.close();
  rmrf(home);
  rmrf(path.dirname(repoPath));
});

describe('cursor auth', () => {
  it('detects CURSOR_API_KEY', () => {
    expect(detectCursorAuth({ CURSOR_API_KEY: 'cursor_x' }).ok).toBe(true);
    expect(detectCursorAuth({}).ok).toBe(false);
    expect(NO_CURSOR_AUTH_MESSAGE).toMatch(/CURSOR_API_KEY/);
  });
});

describe('cursor stream normalize', () => {
  it('maps Shell/shell/edit to Claude-style tool names', () => {
    expect(normalizeCursorToolName('Shell')).toBe('Bash');
    expect(normalizeCursorToolName('shell')).toBe('Bash');
    expect(normalizeCursorToolName('edit')).toBe('Edit');
    expect(normalizeCursorToolName('mcp__custom-user-tools__ask_user')).toBe('ask_user');
  });

  it('maps tool_call events to agent state', () => {
    const fm = h.fm;
    const m = new StreamMapper(fm, 'wren', repoPath, 'worker');
    m.handle({ type: 'tool_call', call_id: '1', name: 'shell', status: 'running', args: { command: 'npm test' } });
    expect(fm.agent('wren')!.state).toBe('testing');
    expect(fm.agent('wren')!.station).toBe('testbench');
    m.handle({ type: 'tool_call', call_id: '2', name: 'edit', status: 'running', args: { path: path.join(repoPath, 'a.ts'), old_string: 'a', new_string: 'b' } });
    expect(fm.agent('wren')!.state).toBe('editing');
    m.applyResult({ status: 'finished', result: 'ok', usage: { totalCostUsd: 0.02 } });
    expect(m.stats.isError).toBe(false);
    expect(m.stats.costUsd).toBe(0.02);
  });
});

describe('cursor backend orchestration (fake SDK)', () => {
  it('plans, works in worktrees, asks the user, reviews, merges and completes the goal', async () => {
    const fm = h.fm;
    expect(fm.agent('rowan')!.active).toBe(false);
    const goal = await fm.submitGoal('Add a --version flag');
    await until(() => fm.tasks.list().length === 2 && fm.goal(goal.id)!.status === 'active');

    await until(() => fm.decisions.open().some((d) => d.kind === 'permission'));
    const perm = fm.decisions.open().find((d) => d.kind === 'permission')!;
    expect(perm.question).toContain('npm install left-pad');
    await fm.answerDecision(perm.id, 'Deny');
    await until(() => permissionVerdict !== undefined);
    expect(permissionVerdict).toBe('deny');

    await until(() => fm.decisions.open().some((d) => d.kind === 'question'));
    const q = fm.decisions.open().find((d) => d.kind === 'question')!;
    await fm.answerDecision(q.id, 0);

    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    expect(fm.tasks.get('t1')!.ci).toBe('pass');
    const m1 = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't1')!;
    await fm.answerDecision(m1.id, 'Merge');
    expect(fm.tasks.get('t1')!.status).toBe('done');

    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't2'), 60_000);
    expect(calls.some((c) => c.prompt.startsWith('You ended your turn'))).toBe(true);
    const m2 = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't2')!;
    await fm.answerDecision(m2.id, 'Merge');
    await until(() => fm.goal(goal.id)!.status === 'done');

    expect(fm.store.data.backend.cursor).toBeDefined();
    expect(fm.store.data.sessions[`marlow:${goal.id}`]?.sessionId).toBeTruthy();
    expect(fs.existsSync(path.join(repoPath, '.cursor', 'hooks.json'))).toBe(true);

    // git-safety env is applied on the Foreman process before Agent.create/send
    const kitTurn = calls.find((c) => /Your task/.test(c.prompt) && c.cwd.includes('kit-'))!;
    const env = kitTurn.env!;
    expect(env.GIT_AUTHOR_NAME).toBe('AgentCraft Kit');
    expect(env.GIT_COMMITTER_EMAIL).toBe('kit@agentcraft.local');
    expect(env.GIT_CEILING_DIRECTORIES!.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(path.dirname(kitTurn.cwd));
    const cfg = Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_x, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]),
    );
    expect(cfg['commit.gpgsign']).toBe('false');
    expect(cfg['protocol.allow']).toBe('never');
    expect(calls.find((c) => c.prompt.startsWith('New goal'))!.env!.GIT_AUTHOR_NAME).toBe('AgentCraft Marlow');
  });
});

describe('cursor abort', () => {
  it('cancel is invoked when a turn is stopped', async () => {
    const cancelled: string[] = [];
    const home2 = tempDir();
    const repo2 = await demoRepo();
    const h2 = makeForeman(home2, ['--backend', 'cursor', '--workers', 'kit', '--repo', repo2]);
    let resolveHold: (() => void) | undefined;
    const hold = new Promise<void>((r) => {
      resolveHold = r;
    });
    const be = new CursorBackend(h2.fm, h2.cfg.cursor, {
      skipAuthCheck: true,
      createAgent: async () => ({
        agentId: 'cursor-agent-abort',
        async send() {
          return {
            id: 'run-abort',
            async *stream() {
              yield { type: 'system', subtype: 'init', agent_id: 'cursor-agent-abort' } as CursorSDKMessage;
              await hold;
            },
            async wait() {
              await hold;
              return { status: 'finished' as const, result: 'ok' };
            },
            supports: (op: string) => op === 'cancel',
            async cancel() {
              cancelled.push('cancel');
              resolveHold?.();
            },
          };
        },
        async close() {},
      }),
      resumeAgent: async () => {
        throw new Error('no resume');
      },
    });
    await h2.fm.start(be);
    await h2.fm.submitGoal('Hold a turn');
    await until(() => h2.fm.agent('marlow')!.state !== 'idle', 10_000);
    await h2.fm.agentAction('marlow', 'stop');
    await until(() => cancelled.includes('cancel'), 5_000);
    expect(cancelled).toContain('cancel');
    await h2.fm.close();
    rmrf(home2);
    rmrf(path.dirname(repo2));
  });
});

describe('cursor hand-off', () => {
  it("stop: Juniper continues from Kit's branch", async () => {
    let juniperSawKitWork: boolean | undefined;
    const home2 = tempDir();
    const repo2 = await demoRepo();
    const h2 = makeForeman(home2, ['--backend', 'cursor', '--workers', 'kit,juniper', '--repo', repo2]);
    const factory = async (opts: CursorAgentOptions): Promise<CursorAgent> => {
      const agentId = sid(String(++n));
      return {
        agentId,
        async send(prompt: string) {
          async function play() {
            if (prompt.startsWith('New goal')) {
              await callCustom(opts, 'create_task', {
                title: 'Add a --version flag',
                description: 'print version',
                assignee: 'kit',
              });
              return;
            }
            const task = /Your task: (t\d+)/.exec(prompt)?.[1];
            const cwd = opts.local.cwd;
            if (task && cwd.includes('kit-')) {
              fs.writeFileSync(path.join(cwd, 'KIT_PARTIAL.md'), 'half-done by Kit\n');
              await callCustom(opts, 'ask_user', { question: 'Short or long?', options: ['Short', 'Long'] });
              return;
            }
            if (task && cwd.includes('juniper-')) {
              juniperSawKitWork = fs.existsSync(path.join(cwd, 'KIT_PARTIAL.md'));
              fs.appendFileSync(path.join(cwd, 'README.md'), '\nversion flag (Juniper)\n');
              await callCustom(opts, 'update_task', { task_id: task, status: 'review', summary: 'finished by Juniper' });
              return;
            }
            const review = /Review request: (t\d+)/.exec(prompt)?.[1];
            if (review) await callCustom(opts, 'request_merge', { task_id: review, summary: 'ok' });
          }
          const done = play();
          return {
            id: `run-${agentId}`,
            async *stream() {
              await done;
              yield { type: 'system', subtype: 'init', agent_id: agentId } as CursorSDKMessage;
            },
            async wait() {
              await done;
              return { status: 'finished' as const, result: 'ok' };
            },
            supports: (op: string) => op === 'cancel',
            async cancel() {},
          };
        },
        async close() {},
      };
    };
    const be2 = new CursorBackend(h2.fm, h2.cfg.cursor, {
      skipAuthCheck: true,
      createAgent: factory,
      resumeAgent: async (id, opts) => ({ ...(await factory(opts)), agentId: id }),
    });
    await h2.fm.start(be2);
    await h2.fm.submitGoal('version flag');
    await until(() => h2.fm.decisions.open().some((d) => d.kind === 'question' && d.agentId === 'kit'));
    await h2.fm.agentAction('kit', 'stop');
    await until(() => h2.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 30_000);
    expect(juniperSawKitWork).toBe(true);
    const t1 = h2.fm.tasks.get('t1')!;
    expect(t1.assignee).toBe('juniper');
    expect(t1.worktree).toBe('juniper-t1');
    const diff = await h2.fm.repos.diff('demo-app', 'juniper-t1');
    expect(diff.files.map((f) => f.path).sort()).toEqual(['KIT_PARTIAL.md', 'README.md']);
    expect(h2.fm.repos.findWorktree('demo-app', 'kit-t1')!.status).toBe('abandoned');
    await h2.fm.close();
    rmrf(home2);
    rmrf(path.dirname(repo2));
  });
});
