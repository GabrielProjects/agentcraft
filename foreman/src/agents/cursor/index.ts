// Cursor backend: Cursor Agent SDK sessions for the lead and workers.
//
// Same orchestration as ClaudeBackend (plan/work/review/followup, tick, hand-off, pause/stop),
// but each turn uses Agent.create / Agent.resume + run.stream() from @cursor/sdk, with
// AgentCraft tools as local.customTools and permissions via project hooks + a local bridge.
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { CursorConfig } from '../../config.js';
import { FOREMAN_VERSION } from '../../config.js';
import { ClientError, type Backend, type Foreman } from '../../foreman.js';
import { withGitSafety } from '../../gitsafety.js';
import { agentGitIdentity } from '../../util/git.js';
import type { Decision, Goal, Task } from '../../protocol.js';
import { MERGE_OPTIONS } from '../../protocol.js';
import type { TestResult } from '../../repos.js';
import { renderDiffText } from '../../diff.js';
import { formatInbox } from '../../bus.js';
import { descendantsOf, killSnapshot, killTree, orphansOf, processTable, type ProcEntry } from '../../util/proc.js';
import { truncate } from '../../util/text.js';
import { leadSystemPrompt, planPrompt, RESUME_PROMPT, reviewPrompt, workerSystemPrompt, workPrompt } from '../common/prompts.js';
import { detectCursorAuth, NO_CURSOR_AUTH_MESSAGE } from './auth.js';
import { StreamMapper, type TurnStats } from './stream.js';
import { createLocalAgent, resumeLocalAgent } from './client.js';
import { PermissionBridge, newHookToken } from './hooks.js';
import { buildCustomTools, type ToolHooks, type TurnHandle } from './tools.js';
import type { CreateAgentFn, CursorAgent, CursorAgentOptions, CursorRun, ResumeAgentFn } from './types.js';
import { userName } from '../../user.js';

type JobKind = 'plan' | 'work' | 'review' | 'followup';
type AbortReason = 'pause' | 'stop' | 'shutdown' | 'cancel' | 'timeout';

interface Job {
  kind: JobKind;
  agentId: string;
  prompt: string;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
  /** start a new session even if one exists for the key */
  fresh?: boolean;
  /** nudges already sent for this task (worker ended without update_task) */
  nudges?: number;
  /** continuing an interrupted job (restart, pause): log the prompt */
  resumed?: boolean;
}

interface Inflight {
  kind: JobKind;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
  startedAt: number;
}

interface CursorState {
  inflight: Record<string, Inflight>;
  ciFixes: Record<string, number>;
  /** agents the user stopped (off shift until resume/spawn) */
  stopped: string[];
}

interface Running {
  abort: AbortController;
  job: Job;
  reason?: AbortReason;
  /** live Cursor run (cancel on abort) */
  run?: CursorRun;
  /** live Cursor agent (disposed after turn) */
  agent?: CursorAgent;
  /** the agent's CLI process (when available) */
  child?: ChildProcess;
  done?: Promise<void>;
  spawnedAt?: number;
  tree?: Promise<ProcEntry[] | undefined>;
  reaping?: Promise<void>;
  hookToken?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function alive(child: ChildProcess | undefined): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null;
}

const TURN_TIMEOUT_MS = 45 * 60_000;
const LEAD = 'marlow';

/**
 * Environment for an agent's CLI process (and every command it runs): git refuses all
 * transports (no push, ever) and never signs; git does not walk up out of the agent's cwd; the
 * agent's commits carry its own placeholder identity ("AgentCraft Kit <kit@agentcraft.local>"),
 * never the user's; and each Bash call starts in the agent's own cwd, so a `cd` in one command
 * cannot carry the next one out of the worktree.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env, who: { agentId?: string; cwd?: string } = {}): Record<string, string | undefined> {
  return withGitSafety(
    base,
    {
      CURSOR_AGENTCRAFT: '1',
      AGENTCRAFT_FOREMAN: `agentcraft-foreman/${FOREMAN_VERSION}`,
      ...(who.agentId ? (agentGitIdentity(who.agentId) as Record<string, string>) : {}),
    },
    who.cwd ? { ceiling: path.dirname(path.resolve(who.cwd)) } : {},
  );
}

export interface CursorBackendOptions {
  /** injectable for tests */
  createAgent?: CreateAgentFn;
  /** injectable for tests */
  resumeAgent?: ResumeAgentFn;
  /** skip the startup auth probe (tests) */
  skipAuthCheck?: boolean;
}

export class CursorBackend implements Backend {
  readonly name = 'cursor' as const;
  private queues = new Map<string, Job[]>();
  private running = new Map<string, Running>();
  private pausedJobs = new Map<string, Job>();
  private tickTimer: NodeJS.Timeout | undefined;
  private authFailed = false;
  private stopping = false;
  private waitingUser = new Set<string>();
  private readonly createAgentFn?: CreateAgentFn;
  private readonly resumeAgentFn?: ResumeAgentFn;
  private bridge!: PermissionBridge;
  private hooks: ToolHooks;
  private lastCost = new Map<string, number>();
  private turnPromises = new Set<Promise<void>>();
  /** tasks whose CI + review hand-off is in progress */
  private reviewing = new Set<string>();
  /** the most recent turn per agent (kept after it ends, for quiesce) */
  private lastTurn = new Map<string, Running>();
  /** tasks changing hands: off the board until the old turn is over and its work committed */
  private handoffs = new Map<string, Promise<void>>();
  /** scheduler retry after an error (backoff) */
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelayMs = 2000;

  constructor(
    private fm: Foreman,
    private cfg: CursorConfig,
    private opts: CursorBackendOptions = {},
  ) {
    this.createAgentFn = opts.createAgent;
    this.resumeAgentFn = opts.resumeAgent;
    this.bridge = new PermissionBridge(fm);
    this.hooks = {
      onReview: () => {
        /* handled after the worker's turn ends (CI then review) */
      },
      onChangesRequested: (taskId, feedback) => this.sendBackToWorker(taskId, `Marlow reviewed your work on ${taskId} and asks for changes:\n${feedback}\n\nMake the changes, re-run the tests, then update_task("${taskId}", status "review", summary).`),
      onTasksChanged: () => this.tick(),
      onMergeRequested: (taskId) => this.fm.log.info(`merge decision opened for ${taskId}`),
      onWaiting: (agentId, waiting) => {
        if (waiting) this.waitingUser.add(agentId);
        else this.waitingUser.delete(agentId);
      },
    };
  }

  private get st(): CursorState {
    const b = this.fm.store.data.backend;
    let s = b.cursor as CursorState | undefined;
    if (!s) {
      s = { inflight: {}, ciFixes: {}, stopped: [] };
      b.cursor = s;
    }
    s.inflight ??= {};
    s.ciFixes ??= {};
    s.stopped ??= [];
    return s;
  }

  get team(): string[] {
    return this.cfg.workers.filter((w) => this.fm.agent(w));
  }

  private isStopped(agentId: string): boolean {
    return this.st.stopped.includes(agentId);
  }

  private setStopped(agentId: string, stopped: boolean): void {
    const s = this.st;
    s.stopped = s.stopped.filter((x) => x !== agentId);
    if (stopped) s.stopped.push(agentId);
    this.fm.store.markDirty();
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.bridge.start();
    // Local Cursor agents inherit process.env (no per-process env like Claude's CLI spawn).
    // Apply git push/signing blocks once for the Foreman process; per-turn agent identity is best-effort.
    const safety = agentEnv(process.env, {});
    for (const [k, v] of Object.entries(safety)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const a of this.fm.agents()) {
      const onTeam = (a.id === LEAD || this.team.includes(a.id)) && !this.isStopped(a.id);
      this.fm.setAgent(a.id, { active: onTeam });
      if (!onTeam) this.fm.setAgent(a.id, { state: 'idle', station: 'lounge', activity: this.isStopped(a.id) ? 'stopped - off shift' : 'off shift' });
      else if (a.activity === 'off shift' || a.activity.startsWith('stopped')) this.fm.setAgent(a.id, { activity: 'ready' });
    }
    // the spend survives restarts: every session's cost is persisted, so the total is their sum
    const spent = Object.values(this.fm.store.data.sessions).reduce((sum, s) => sum + (s.costUsd || 0), 0);
    if (spent > 0) this.fm.setStatus({ costUsd: Math.round(spent * 1000) / 1000 });
    await this.checkAuth();
    if (!this.cfg.resumeOnStart) {
      this.st.inflight = {};
    } else {
      this.recover();
    }
    // the user's messages that no agent read before the restart
    for (const id of [LEAD, ...this.team]) this.deliverPending(id);
    void this.fm.repos.sweepPendingRemovals().catch((e) => this.fm.log.debug(`sweep: ${(e as Error).message}`));
    this.tick();
  }

  async checkAuth(): Promise<boolean> {
    if (this.opts.skipAuthCheck) {
      this.fm.setStatus({ auth: 'ok', message: `Cursor (lead ${this.cfg.leadModel}, workers ${this.cfg.workerModel})` });
      return true;
    }
    const api = detectCursorAuth(process.env);
    if (!api.ok) {
      this.markAuthFailed(NO_CURSOR_AUTH_MESSAGE);
      return false;
    }
    this.authFailed = false;
    this.fm.setStatus({ auth: 'ok', account: api.source, message: `Cursor (lead ${this.cfg.leadModel}, workers ${this.cfg.workerModel})` });
    this.fm.log.info(`cursor auth ok (${api.source})`);
    return true;
  }

  private markAuthFailed(message: string): void {
    this.authFailed = true;
    this.fm.setStatus({ auth: 'failed', message });
    this.fm.log.error(message);
    this.fm.bus.feed('error', message);
    this.fm.notify('warn', message);
    if (process.stdout.isTTY) process.stdout.write('\x07');
  }

  private openQuestion(agentId: string): Decision | undefined {
    return this.fm.decisions.open().find((d) => d.kind === 'question' && d.agentId === agentId);
  }

  /** A job matching `pred` is queued, running or paused (waiting for /resume) for this agent. */
  private hasQueued(agentId: string, pred: (j: Job) => boolean): boolean {
    const running = this.running.get(agentId);
    const paused = this.pausedJobs.get(agentId);
    return (this.queues.get(agentId) ?? []).some(pred) || (running ? pred(running.job) : false) || (paused ? pred(paused) : false);
  }

  /**
   * After a restart: re-attach or re-queue everything that was in flight, then reconcile every
   * non-terminal state with what is actually running, so nothing waits forever.
   */
  private recover(): void {
    const st = this.st;
    // permission prompts from a dead process are moot; the resumed agent retries the tool
    for (const d of this.fm.decisions.open().filter((x) => x.kind === 'permission')) this.fm.decisions.cancel(d.id, 'Foreman restarted');
    for (const [agentId, inf] of Object.entries(st.inflight)) {
      if (this.isStopped(agentId) || !this.fm.agent(agentId)) {
        delete st.inflight[agentId];
        continue;
      }
      const openQ = this.openQuestion(agentId);
      if (openQ) {
        this.fm.log.info(`recover: ${agentId} is waiting on ${openQ.id}; will resume after the answer`);
        this.fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'waiting for your answer' });
        continue;
      }
      const session = this.fm.store.data.sessions[inf.sessionKey];
      if (session?.sessionId) {
        this.fm.log.info(`recover: resuming ${agentId} (${inf.kind}${inf.taskId ? ` ${inf.taskId}` : ''})`);
        this.enqueue({ kind: inf.kind, agentId, sessionKey: inf.sessionKey, prompt: RESUME_PROMPT, resumed: true, ...(inf.taskId ? { taskId: inf.taskId } : {}), ...(inf.goalId ? { goalId: inf.goalId } : {}) });
      } else {
        // the turn died before it had a session: the reconciliation below starts it again
        delete st.inflight[agentId];
      }
    }
    this.reconcile();
    this.fm.store.markDirty();
  }

  /** Bring planning goals, doing tasks and review tasks back in line with running/queued jobs. */
  private reconcile(): void {
    const st = this.st;
    // goals still planning with nobody planning them
    for (const g of this.fm.goals().filter((x) => x.status === 'planning')) {
      const leadOnIt = st.inflight[LEAD]?.goalId === g.id || this.hasQueued(LEAD, (j) => j.goalId === g.id) || this.openQuestion(LEAD) !== undefined;
      if (leadOnIt || this.isStopped(LEAD)) continue;
      if (this.fm.tasks.forGoal(g.id).length) this.promoteGoal(g, 'recovered');
      else {
        const repo = g.repoId ? this.fm.repos.get(g.repoId) : undefined;
        if (!repo) continue;
        this.fm.log.info(`recover: re-planning ${g.id}`);
        this.enqueue({ kind: 'plan', agentId: LEAD, goalId: g.id, sessionKey: `${LEAD}:${g.id}`, fresh: !this.fm.store.data.sessions[`${LEAD}:${g.id}`]?.sessionId, prompt: planPrompt(this.fm, g, repo.path, repo.branch) });
      }
    }
    // doing tasks whose worker is not working on them: back on the board (the session resumes)
    for (const t of this.fm.tasks.list()) {
      if (t.status !== 'doing' || !t.assignee || t.assignee === LEAD) continue;
      const w = t.assignee;
      if (st.inflight[w]?.taskId === t.id || this.hasQueued(w, (j) => j.taskId === t.id)) continue;
      if (this.openQuestion(w)?.taskId === t.id) continue; // resumes with the answer
      this.fm.log.info(`recover: ${t.id} was doing without a running turn; re-queued`);
      this.fm.tasks.setStatus(t.id, 'todo', { force: true });
      if (this.isStopped(w)) this.fm.tasks.update(t.id, { assignee: null });
    }
    this.sweepReviews();
  }

  /** Tasks in review with no merge decision and no review job: CI + review (again). */
  private sweepReviews(): void {
    const st = this.st;
    for (const t of this.fm.tasks.list()) {
      if (t.status !== 'review' || !t.worktree) continue;
      if (this.fm.decisions.open().some((d) => d.taskId === t.id)) continue;
      if (Object.values(st.inflight).some((i) => i.taskId === t.id)) continue;
      if (this.reviewing.has(t.id) || this.hasQueued(LEAD, (j) => j.taskId === t.id) || (t.assignee && this.hasQueued(t.assignee, (j) => j.taskId === t.id))) continue;
      void this.afterWorkerDone(t.id);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const turns = [...this.running.values()];
    for (const r of turns) this.abortTurn(r, 'shutdown');
    await Promise.race([Promise.allSettled([...this.turnPromises]), sleep(4000)]);
    // nothing an agent started outlives the Foreman (sessions resume on the next start)
    await Promise.race([Promise.allSettled(turns.map((r) => this.reap(r, 1500))), sleep(3000)]);
    // inflight entries stay persisted so the next start resumes them
    this.fm.store.markDirty();
    await this.bridge.stop();
  }

  // ---- turn teardown ------------------------------------------------------------------------

  /** Abort a turn: remember why, snapshot its process tree while the CLI is still alive, close it. */
  private abortTurn(r: Running, reason: AbortReason): void {
    r.reason = reason;
    const pid = r.child?.pid;
    if (pid && alive(r.child) && !r.tree) r.tree = processTable().then((t) => (t ? descendantsOf(t, pid) : undefined)).catch(() => undefined);
    r.abort.abort();
  }

  /**
   * Make sure an aborted turn's CLI process and everything it started are gone. The SDK's close()
   * gives the CLI ~2 s to exit; after that its tree is killed. Processes that outlived the CLI
   * (orphans on Windows) come from the snapshot taken at abort time plus, read after the CLI
   * exited, every newer process whose parent chain leads to the CLI's pid (unless that pid was
   * reused). Only processes that are still the same ones (pid + creation time) are killed.
   */
  private reap(r: Running, graceMs = 4000): Promise<void> {
    r.reaping ??= this.doReap(r, graceMs).catch((e) => this.fm.log.warn(`clean-up of ${r.job.agentId}'s turn: ${(e as Error).message}`));
    return r.reaping;
  }

  private async doReap(r: Running, graceMs: number): Promise<void> {
    const child = r.child;
    if (!child?.pid) return;
    if (alive(child)) {
      await Promise.race([new Promise<void>((res) => child.once('exit', () => res())), sleep(graceMs)]);
      if (alive(child)) {
        killTree(child);
        await Promise.race([new Promise<void>((res) => child.once('exit', () => res())), sleep(2000)]);
      }
    }
    const snapshot = r.tree ? await r.tree : undefined;
    const table = await processTable();
    if (!table) {
      this.fm.log.warn(`could not read the process table to check for processes left by ${r.job.agentId}'s stopped turn`);
      return;
    }
    const targets = new Map<number, ProcEntry>();
    for (const e of [...(snapshot ?? []), ...orphansOf(table, child.pid, r.spawnedAt ?? 0)]) targets.set(e.pid, e);
    const killed = (await killSnapshot([...targets.values()], table)) ?? [];
    if (killed.length) this.fm.log.info(`killed ${killed.length} leftover process(es) of ${r.job.agentId}'s stopped turn (pids ${killed.join(', ')})`);
  }

  /** Wait until an agent's current/last turn is completely over (CLI exited, its processes gone). */
  private async quiesce(agentId: string, maxMs = 15_000): Promise<void> {
    const r = this.running.get(agentId) ?? this.lastTurn.get(agentId);
    if (!r) return;
    if (r.done) await Promise.race([r.done.catch(() => undefined), sleep(maxMs)]);
    await this.reap(r);
  }

  /**
   * A task leaves `fromAgent` (stop, reassign): hold it off the board until that agent's turn is
   * really over, then commit its work on its branch (the next worker starts from that branch).
   */
  private handOff(taskId: string, fromAgent: string, why: string): void {
    if (this.handoffs.has(taskId)) return;
    const p = (async () => {
      try {
        await this.quiesce(fromAgent);
        const t = this.fm.tasks.get(taskId);
        const wt = t?.worktree && t.repoId ? this.fm.repos.findWorktree(t.repoId, t.worktree) : undefined;
        if (t && wt && wt.agentId === fromAgent && wt.status === 'active') {
          await this.fm.repos.abandon(t.repoId!, wt.id, `agentcraft: ${t.id} work in progress (${why})`);
        }
      } catch (e) {
        this.fm.log.warn(`hand-off of ${taskId} from ${fromAgent}: ${(e as Error).message}`);
      } finally {
        this.handoffs.delete(taskId);
        this.tick();
      }
    })();
    this.handoffs.set(taskId, p);
  }

  /** Scheduler failed (git error, busy directory...): try again later instead of stalling. */
  private retryLater(): void {
    if (this.retryTimer || this.stopping) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(60_000, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.tick();
    }, delay);
    this.retryTimer.unref?.();
  }

  // ---- goals & scheduling -------------------------------------------------------------------

  async submitGoal(goal: Goal): Promise<void> {
    if (this.authFailed) {
      this.fm.setGoal(goal.id, { status: 'failed' });
      throw new ClientError(`Cursor is not available: ${this.fm.status.message ?? 'auth failed'}`);
    }
    const repo = this.fm.repos.require(goal.repoId!);
    if (this.isStopped(LEAD)) {
      this.setStopped(LEAD, false);
      this.fm.bus.feed('system', 'Marlow is back on shift for the new goal', { agentId: LEAD });
    }
    for (const w of [LEAD, ...this.team]) if (!this.isStopped(w)) this.fm.setAgent(w, { active: true });
    this.fm.setAgent(LEAD, { state: 'thinking', station: 'meeting', activity: 'reading the goal', repoId: repo.id });
    this.enqueue({ kind: 'plan', agentId: LEAD, goalId: goal.id, sessionKey: `${LEAD}:${goal.id}`, fresh: true, prompt: planPrompt(this.fm, goal, repo.path, repo.branch) });
  }

  private promoteGoal(goal: Goal, why: string): void {
    if (goal.status !== 'planning') return;
    const n = this.fm.tasks.forGoal(goal.id).length;
    this.fm.setGoal(goal.id, { status: 'active' });
    this.fm.bus.feed('plan', `Marlow planned the goal into ${n} task${n === 1 ? '' : 's'}${why === 'recovered' ? ' (picked up after a restart)' : ''}`, { agentId: LEAD });
    this.tick();
  }

  tick(): void {
    if (this.tickTimer || this.stopping) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      this.schedule().catch((e) => {
        this.fm.log.error(`scheduler: ${(e as Error).stack ?? e}`);
        this.retryLater();
      });
    }, 50);
    this.tickTimer.unref?.();
  }

  private workersRunning(): number {
    return [...this.running.keys()].filter((id) => id !== LEAD).length;
  }

  private isFree(w: string): boolean {
    const a = this.fm.agent(w);
    if (!a || !a.active || a.paused || this.isStopped(w) || !this.team.includes(w)) return false;
    if (this.running.has(w) || (this.queues.get(w)?.length ?? 0) > 0) return false;
    return !this.fm.tasks.list().some((t) => t.assignee === w && t.status === 'doing');
  }

  private async schedule(): Promise<void> {
    if (this.authFailed || this.stopping) return;
    for (const goal of this.fm.goals().filter((g) => g.status === 'active')) {
      for (const t of this.fm.tasks.ready(goal.id)) {
        if (this.workersRunning() >= this.cfg.maxConcurrent) return;
        if (this.handoffs.has(t.id)) continue; // the previous worker's turn is still winding down
        let w: string | undefined;
        if (t.assignee && this.team.includes(t.assignee) && !this.isStopped(t.assignee)) {
          if (!this.isFree(t.assignee)) continue; // wait for the intended worker
          w = t.assignee;
        } else {
          w = this.team.find((x) => this.isFree(x));
        }
        if (!w) continue;
        try {
          await this.startWork(w, t, goal);
          this.retryDelayMs = 2000;
        } catch (e) {
          // the task stays on the board (assigned to w); try again shortly
          this.fm.log.error(`could not start ${t.id} for ${w}: ${(e as Error).message}`);
          this.retryLater();
        }
      }
    }
    // pump queues that were held back by the concurrency cap
    for (const id of this.queues.keys()) this.pump(id);
  }

  private async startWork(agentId: string, t: Task, goal: Goal): Promise<void> {
    if (!t.repoId) t.repoId = goal.repoId;
    this.fm.tasks.update(t.id, { assignee: agentId });
    // a task another worker started (stopped / reassigned): continue from that worker's branch,
    // whether or not its worktree was already wound down (abandoned)
    let startPoint: string | undefined;
    let continuesFrom: string | undefined;
    const prev = t.worktree ? this.fm.repos.findWorktree(t.repoId!, t.worktree) : undefined;
    if (prev && prev.agentId !== agentId && prev.status !== 'merged') {
      if (prev.status === 'active') {
        // nobody prepared the hand-off (e.g. reconciled after a restart): finish it here
        if (this.lastTurn.get(prev.agentId)?.job.taskId === t.id) await this.quiesce(prev.agentId);
        await this.fm.repos.abandon(t.repoId!, prev.id, `agentcraft: ${t.id} work in progress (handed to ${this.fm.nameOf(agentId)})`).catch((e) => this.fm.log.warn(`abandon ${prev.id}: ${(e as Error).message}`));
      }
      if ((await this.fm.repos.commitsAhead(t.repoId!, prev.branch, prev.base)) > 0) {
        startPoint = prev.branch;
        continuesFrom = prev.agentId;
        this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} continues ${t.id} from ${this.fm.nameOf(prev.agentId)}'s branch`, { agentId });
      }
    }
    const wt = await this.fm.repos.createWorktree(t.repoId!, agentId, t, startPoint ? { startPoint } : {});
    this.fm.tasks.update(t.id, { branch: wt.branch, worktree: wt.id });
    this.fm.tasks.setStatus(t.id, 'doing');
    this.fm.setAgent(agentId, { taskId: t.id, repoId: t.repoId!, worktree: wt.id, state: 'thinking', station: 'desk', activity: `starting ${t.id}` });
    this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} started ${t.id}: ${t.title}`, { agentId });
    const inbox = formatInbox(this.fm.bus.inbox(agentId, { markRead: true }), (id) => this.fm.nameOf(id));
    this.enqueue({ kind: 'work', agentId, taskId: t.id, goalId: goal.id, sessionKey: `${agentId}:${t.id}`, fresh: !this.fm.store.data.sessions[`${agentId}:${t.id}`]?.sessionId, prompt: workPrompt(this.fm, t, goal, wt, inbox, continuesFrom) });
  }

  // ---- job queue ----------------------------------------------------------------------------

  private enqueue(job: Job): void {
    const q = this.queues.get(job.agentId) ?? [];
    q.push(job);
    this.queues.set(job.agentId, q);
    this.pump(job.agentId);
  }

  private pump(agentId: string): void {
    if (this.stopping || this.authFailed) return;
    if (this.running.has(agentId)) return;
    const a = this.fm.agent(agentId);
    if (!a || a.paused || !a.active || this.isStopped(agentId)) return;
    const q = this.queues.get(agentId);
    if (!q?.length) return;
    if (agentId !== LEAD && this.workersRunning() >= this.cfg.maxConcurrent) return;
    const job = q.shift()!;
    const p = this.runJob(job).finally(() => {
      this.turnPromises.delete(p);
    });
    this.turnPromises.add(p);
    // runJob registers its Running entry synchronously, before its first await
    const entry = this.running.get(agentId);
    if (entry) {
      entry.done = p;
      this.lastTurn.set(agentId, entry);
    }
  }

  private env(who: { agentId?: string; cwd?: string } = {}): Record<string, string | undefined> {
    return agentEnv(process.env, who);
  }

  private cwdFor(job: Job): { cwd: string; role: 'lead' | 'worker' } {
    if (job.agentId === LEAD) {
      const goal = job.goalId ? this.fm.goal(job.goalId) : this.fm.currentGoal();
      const repo = goal?.repoId ? this.fm.repos.get(goal.repoId) : this.fm.repos.defaultRepo();
      if (!repo) throw new Error('no repo for the lead');
      return { cwd: repo.path, role: 'lead' };
    }
    const t = job.taskId ? this.fm.tasks.get(job.taskId) : undefined;
    if (!t?.worktree || !t.repoId) throw new Error(`job for ${job.agentId} has no worktree`);
    return { cwd: this.fm.repos.requireWorktree(t.repoId, t.worktree).path, role: 'worker' };
  }

  private async runJob(job: Job): Promise<void> {
    const agentId = job.agentId;
    const abort = new AbortController();
    const entry: Running = { abort, job };
    const turn: TurnHandle = { signal: abort.signal, reason: () => entry.reason };
    const previous = this.lastTurn.get(agentId);
    this.running.set(agentId, entry);
    let stats: TurnStats | undefined;
    let cwd = '';
    const hookToken = newHookToken();
    entry.hookToken = hookToken;
    try {
      if (previous?.reaping) await Promise.race([previous.reaping, sleep(10_000)]);
      const where = this.cwdFor(job);
      cwd = where.cwd;
      const role = where.role;
      const session = this.fm.store.data.sessions[job.sessionKey];
      const resumeId = !job.fresh && session?.sessionId ? session.sessionId : undefined;
      this.st.inflight[agentId] = { kind: job.kind, sessionKey: job.sessionKey, startedAt: Date.now(), ...(job.taskId ? { taskId: job.taskId } : {}), ...(job.goalId ? { goalId: job.goalId } : {}) };
      this.fm.store.markDirty();

      let systemAppend: string;
      if (role === 'lead') systemAppend = leadSystemPrompt(this.fm, this.team);
      else {
        const t = this.fm.tasks.require(job.taskId!);
        systemAppend = workerSystemPrompt(this.fm, agentId, this.fm.repos.requireWorktree(t.repoId!, t.worktree!));
      }
      const model = role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel;
      const customTools = buildCustomTools(this.fm, agentId, role, this.hooks, turn);
      this.bridge.installHooks(cwd, hookToken);
      this.bridge.register({ agentId, role, cwd, turn, token: hookToken });

      // Apply git-safety env for this process (local Cursor agent inherits process.env).
      const envPatch = this.env({ agentId, cwd });
      const prevEnv: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(envPatch)) {
        prevEnv[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }

      const agentOpts: CursorAgentOptions = {
        apiKey: process.env.CURSOR_API_KEY,
        model: { id: model },
        systemPrompt: systemAppend,
        tools: role === 'lead' ? ['read', 'grep', 'glob', 'ls'] : ['read', 'grep', 'glob', 'ls', 'edit', 'write', 'shell'],
        disallowedTools: ['task', 'webSearch', 'webFetch'],
        local: {
          cwd,
          settingSources: ['project'],
          customTools,
        },
      };

      this.fm.agentLog(agentId, 'text', `${resumeId ? 'Resuming' : 'Starting'} ${job.kind}${job.taskId ? ` ${job.taskId}` : ''} (${model})`);
      if (job.kind === 'followup' || job.resumed) this.fm.agentLog(agentId, 'text', truncate(job.prompt, 400));
      const mapper = new StreamMapper(this.fm, agentId, cwd, role);
      const timer = setTimeout(() => this.abortTurn(entry, 'timeout'), TURN_TIMEOUT_MS);
      timer.unref?.();
      const unread = this.fm.bus.inbox(agentId, { markRead: true });
      const prompt = unread.length ? `${job.prompt}\n\n[New messages]\n${formatInbox(unread, (id) => this.fm.nameOf(id))}` : job.prompt;

      try {
        const agent = resumeId
          ? await resumeLocalAgent(resumeId, agentOpts, this.resumeAgentFn)
          : await createLocalAgent(agentOpts, this.createAgentFn);
        entry.agent = agent;
        entry.spawnedAt = Date.now();
        if (agent.agentId && this.fm.store.data.sessions[job.sessionKey]?.sessionId !== agent.agentId) {
          this.recordSession(job.sessionKey, agent.agentId, model);
        }
        mapper.stats.sessionId = agent.agentId;

        const run = await agent.send(prompt, { local: { customTools } });
        entry.run = run;
        const cancelRun = () => {
          void (async () => {
            try {
              if (run.supports?.('cancel')) await run.cancel?.();
              else await run.cancel?.();
            } catch {
              /* already ended */
            }
          })();
        };
        if (abort.signal.aborted) cancelRun();
        else abort.signal.addEventListener('abort', cancelRun, { once: true });

        for await (const msg of run.stream()) {
          if (abort.signal.aborted) break;
          mapper.handle(msg);
          if (mapper.stats.sessionId && this.fm.store.data.sessions[job.sessionKey]?.sessionId !== mapper.stats.sessionId) {
            this.recordSession(job.sessionKey, mapper.stats.sessionId, model);
          }
        }
        if (!abort.signal.aborted) {
          const result = await run.wait();
          mapper.applyResult(result);
        }
      } finally {
        clearTimeout(timer);
        for (const [k, v] of Object.entries(prevEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        this.bridge.unregister(hookToken);
        const ag = entry.agent;
        entry.agent = undefined;
        if (ag) {
          try {
            if (typeof ag.close === 'function') await ag.close();
          } catch {
            /* ignore */
          }
        }
      }
      stats = mapper.stats;
      if (stats.sessionId) this.recordSession(job.sessionKey, stats.sessionId, model, stats);
      if (stats.authFailed) this.markAuthFailed(`Cursor authentication failed (${stats.authFailed}). Check CURSOR_API_KEY, then restart the Foreman.`);
    } catch (e) {
      const aborted = abort.signal.aborted;
      if (!aborted) {
        const msg = (e as Error).message ?? String(e);
        this.fm.log.error(`${agentId} ${job.kind} failed: ${msg}`);
        this.fm.agentLog(agentId, 'error', `session error: ${truncate(msg, 400)}`);
        if (/auth|login|credential|401|CURSOR_API_KEY|@cursor\/sdk/i.test(msg)) this.markAuthFailed(`Cursor authentication failed: ${truncate(msg, 160)}`);
        stats = { isError: true, errors: [msg] };
      }
    } finally {
      this.running.delete(agentId);
      if (entry.hookToken) this.bridge.unregister(entry.hookToken);
    }

    const reason = entry.reason;
    if (reason === 'shutdown') return;
    if (reason) void this.reap(entry);
    delete this.st.inflight[agentId];
    this.fm.store.markDirty();
    if (reason === 'pause') {
      const next: Job = { ...job, fresh: false, resumed: true, prompt: `${userName()} paused you and has now resumed you. Any question you had open was withdrawn; ask again if you still need it. Continue your current job.` };
      if (this.fm.agent(agentId)?.paused) {
        this.pausedJobs.set(agentId, next);
        this.fm.setAgent(agentId, { state: 'idle', activity: 'paused' });
      } else this.enqueue(next);
    } else if (reason === 'stop') {
      if (this.isStopped(agentId)) this.fm.setAgent(agentId, { state: 'idle', station: 'lounge', activity: 'stopped - off shift', taskId: null, worktree: null });
    } else if (reason === 'cancel') {
      const a = this.fm.agent(agentId);
      if (a?.taskId === job.taskId) this.fm.setAgent(agentId, { state: 'idle', station: 'lounge', activity: 'task cancelled', taskId: null, worktree: null });
    } else if (reason === 'timeout') {
      this.fm.agentLog(agentId, 'error', `turn timed out after ${TURN_TIMEOUT_MS / 60_000} min`);
      await this.afterTurn(job, { isError: true, subtype: 'timeout', errors: ['turn timed out'] }).catch((e) => this.fm.log.error(`afterTurn ${agentId}: ${(e as Error).stack ?? e}`));
    } else {
      await this.afterTurn(job, stats).catch((e) => this.fm.log.error(`afterTurn ${agentId}: ${(e as Error).stack ?? e}`));
    }
    this.pump(agentId);
    if (reason !== 'stop' && reason !== 'pause') this.deliverPending(agentId);
    this.tick();
  }

  private deliverPending(agentId: string): void {
    if (this.stopping || this.isStopped(agentId) || this.running.has(agentId) || this.pausedJobs.has(agentId) || (this.queues.get(agentId)?.length ?? 0) > 0) return;
    const a = this.fm.agent(agentId);
    if (!a?.active || a.paused) return;
    const fromUser = this.fm.bus.inbox(agentId).filter((m) => m.from === 'user' && m.to === agentId);
    if (!fromUser.length) return;
    this.fm.log.info(`delivering ${fromUser.length} message(s) from ${userName()} to ${agentId} that arrived after its last turn`);
    this.onUserMessage(agentId, fromUser[fromUser.length - 1]!.text);
  }

  private recordSession(key: string, sessionId: string, model: string, stats?: TurnStats): void {
    const s = (this.fm.store.data.sessions[key] ??= { turns: 0, costUsd: 0, updatedAt: Date.now() });
    s.sessionId = sessionId;
    s.model = model;
    s.updatedAt = Date.now();
    if (stats) {
      s.turns += stats.numTurns ?? 0;
      if (typeof stats.costUsd === 'number') {
        // total_cost_usd is cumulative per session (resumes continue from the saved total)
        const prev = this.lastCost.get(sessionId) ?? s.costUsd;
        const delta = Math.max(0, stats.costUsd - prev);
        this.lastCost.set(sessionId, stats.costUsd);
        s.costUsd = Math.max(s.costUsd, stats.costUsd);
        this.fm.setStatus({ costUsd: Math.round(((this.fm.status.costUsd ?? 0) + delta) * 1000) / 1000 });
      }
      s.lastResult = stats.subtype;
    }
    this.fm.store.markDirty();
  }

  // ---- after a turn -------------------------------------------------------------------------

  private failure(stats: TurnStats | undefined): string {
    return truncate(stats?.subtype && stats.subtype !== 'success' ? stats.subtype.replace(/^error_/, '').replace(/_/g, ' ') : (stats?.errors[0] ?? 'error'), 36);
  }

  private async afterTurn(job: Job, stats: TurnStats | undefined): Promise<void> {
    const failed = !stats || stats.isError;
    if (job.agentId === LEAD) {
      this.fm.setAgent(LEAD, failed ? { state: 'error', station: 'meeting', activity: `turn failed: ${this.failure(stats)}` } : { state: 'idle', station: 'meeting', activity: 'watching the task wall' });
      // any lead turn for a goal that is still planning (plan, or a plan resumed after a
      // restart / an answer) settles the goal: tasks -> active
      const goal = job.goalId ? this.fm.goal(job.goalId) : undefined;
      if (goal && goal.status === 'planning') {
        const n = this.fm.tasks.forGoal(goal.id).length;
        if (n > 0) this.promoteGoal(goal, 'planned');
        else if (failed) {
          this.fm.setGoal(goal.id, { status: 'failed' });
          this.fm.bus.feed('error', `Marlow's planning turn ended without tasks${stats?.errors.length ? `: ${stats.errors.join('; ')}` : ''}`, { agentId: LEAD });
        } else if (job.kind === 'plan') {
          // nothing to do (e.g. the user said "ignore it"): close the goal instead of leaving it
          // "active" at 0% forever; a task the lead adds to it later makes it active again
          this.fm.setGoal(goal.id, { status: 'cancelled', progress: 0 });
          this.fm.bus.feed('goal', `Marlow planned no tasks: goal closed (${truncate(goal.text, 80)})`, { agentId: LEAD });
        }
      }
      if (job.kind === 'review' && job.taskId) {
        const t = this.fm.tasks.get(job.taskId);
        const hasDecision = this.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === job.taskId);
        if (t && t.status === 'review' && !hasDecision) {
          // lead gave no verdict: still surface the merge to the user (never auto-merge)
          this.openMergeDecision(t, `Marlow's review: ${truncate(stats?.resultText ?? '(no verdict)', 300)}`);
        }
      }
      return;
    }
    // worker
    const t = job.taskId ? this.fm.tasks.get(job.taskId) : undefined;
    if (!t) {
      this.fm.setAgent(job.agentId, failed ? { state: 'error', station: 'desk', activity: `turn failed: ${this.failure(stats)}` } : { state: 'idle', station: 'lounge', activity: 'idle' });
      return;
    }
    if (t.status === 'review') {
      await this.afterWorkerDone(t.id);
      return;
    }
    if (t.status === 'doing') {
      const nudges = job.nudges ?? 0;
      if (!failed && nudges < 1) {
        this.enqueue({ ...job, kind: 'followup', fresh: false, nudges: nudges + 1, prompt: `You ended your turn but ${t.id} is still "doing". If the work is complete, call update_task("${t.id}", status "review", summary). If you are stuck, call update_task with status "blocked" and blocked_reason. Otherwise continue.` });
        return;
      }
      const wt = t.worktree && t.repoId ? this.fm.repos.findWorktree(t.repoId, t.worktree) : undefined;
      if (wt) await this.fm.repos.refresh(t.repoId!);
      if (!failed && wt && wt.files > 0) {
        this.fm.tasks.setStatus(t.id, 'review', { summary: truncate(stats?.resultText ?? 'work complete', 400) });
        await this.afterWorkerDone(t.id);
      } else {
        this.fm.tasks.setStatus(t.id, 'blocked', { reason: failed ? `session ended: ${stats?.subtype ?? stats?.errors.join('; ') ?? 'error'}` : 'worker stopped without changes', force: true });
        // a failed turn is an error (red); a worker that gave up is blocked
        this.fm.setAgent(job.agentId, failed ? { state: 'error', station: 'desk', activity: `${t.id}: ${this.failure(stats)}` } : { state: 'blocked', station: 'desk', activity: `${t.id} blocked` });
        this.fm.bus.send(job.agentId, LEAD, `${t.id} is blocked: ${this.fm.tasks.get(t.id)?.blockedReason}`);
        this.fm.notify('warn', `${this.fm.nameOf(job.agentId)}: ${t.id} ${failed ? 'failed' : 'is blocked'} (${this.fm.tasks.get(t.id)?.blockedReason ?? ''}) - /task ${t.id} retry when ready`);
      }
      return;
    }
    if (t.status === 'blocked') {
      this.fm.setAgent(job.agentId, { state: 'blocked', station: 'desk', activity: `${t.id} blocked` });
      this.fm.notify('warn', `${this.fm.nameOf(job.agentId)} is blocked on ${t.id}: ${t.blockedReason ?? ''}`);
      return;
    }
    this.fm.setAgent(job.agentId, { state: 'idle', station: 'lounge', activity: 'idle' });
  }

  /** A worker finished a task: CI in the worktree, then lead review (or a merge decision). */
  private async afterWorkerDone(taskId: string): Promise<void> {
    if (this.reviewing.has(taskId)) return; // CI already running for it
    this.reviewing.add(taskId);
    try {
      await this.ciThenReview(taskId);
    } finally {
      this.reviewing.delete(taskId);
    }
  }

  private async ciThenReview(taskId: string): Promise<void> {
    const t = this.fm.tasks.get(taskId);
    if (!t || t.status !== 'review' || !t.repoId || !t.worktree) return;
    const worker = t.assignee;
    if (worker) this.fm.setAgent(worker, { state: 'idle', station: 'lounge', activity: `${t.id} in review` });
    let ci: TestResult | undefined;
    try {
      this.fm.tasks.update(t.id, { ci: 'running' });
      this.fm.repos.setCi(t.repoId, 'running');
      if (worker) this.fm.agentLog(worker, 'tool', `CI: ${this.cfg.ciCommand ?? this.fm.repos.detectTestCommand(this.fm.repos.requireWorktree(t.repoId, t.worktree).path) ?? '(no tests)'}`);
      ci = await this.fm.repos.runTests(t.repoId, t.worktree, this.cfg.ciCommand);
      this.fm.tasks.update(t.id, { ci: ci.pass ? 'pass' : 'fail' });
      this.fm.repos.setCi(t.repoId, ci.pass ? 'pass' : 'fail');
      if (worker) this.fm.agentLog(worker, ci.pass ? 'result' : 'error', `CI ${ci.pass ? 'passed' : 'FAILED'} (${(ci.durationMs / 1000).toFixed(1)}s)\n${ci.output.split('\n').slice(-6).join('\n')}`);
      this.fm.bus.feed('ci', `${t.id}: tests ${ci.pass ? 'pass' : 'fail'} (${ci.command})`, { ...(worker ? { agentId: worker } : {}) });
    } catch (e) {
      this.fm.log.warn(`CI for ${t.id}: ${(e as Error).message}`);
    }
    await this.fm.repos.refresh(t.repoId);
    if (ci && !ci.pass && (this.st.ciFixes[t.id] ?? 0) < 1 && worker && !this.isStopped(worker)) {
      this.st.ciFixes[t.id] = (this.st.ciFixes[t.id] ?? 0) + 1;
      this.sendBackToWorker(t.id, `CI failed for ${t.id} (${ci.command}):\n${ci.output}\n\nFix the failures, re-run the tests, then update_task("${t.id}", status "review", summary).`);
      return;
    }
    if (this.cfg.leadReview && !this.isStopped(LEAD)) {
      const diff = await this.fm.repos.diff(t.repoId, t.worktree);
      this.fm.setAgent(LEAD, { state: 'reading', station: 'mergestation', activity: `reviewing ${t.id}` });
      this.enqueue({ kind: 'review', agentId: LEAD, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${LEAD}:${t.goalId ?? 'adhoc'}`, prompt: reviewPrompt(this.fm, this.fm.tasks.require(t.id), renderDiffText(diff.files), diff.stats, ci) });
    } else {
      this.openMergeDecision(t, t.summary ?? 'Work complete.');
    }
  }

  private openMergeDecision(t: Task, summary: string): void {
    const wt = this.fm.repos.requireWorktree(t.repoId!, t.worktree!);
    this.fm.createDecision({
      agentId: LEAD,
      kind: 'merge',
      question: `Merge ${t.id} "${t.title}" (${wt.branch}) into ${wt.base}?`,
      options: [...MERGE_OPTIONS],
      context: `${summary}\n${wt.files} files, +${wt.additions} -${wt.deletions} | tests: ${t.ci}`,
      taskId: t.id,
      repoId: t.repoId!,
      worktree: wt.id,
    });
    if (!this.isStopped(LEAD)) this.fm.setAgent(LEAD, { state: 'idle', station: 'mergestation', activity: `awaiting your review of ${t.id}` });
  }

  /** Resume the worker's task session with feedback (lead/user changes, CI failure). */
  private sendBackToWorker(taskId: string, prompt: string): void {
    const t = this.fm.tasks.get(taskId);
    if (!t?.assignee) return;
    if (this.isStopped(t.assignee)) {
      // nobody to send it back to: put it on the board for the next free worker
      this.fm.tasks.setStatus(t.id, 'todo', { force: true, summary: truncate(prompt, 400) });
      this.fm.tasks.update(t.id, { assignee: null });
      this.tick();
      return;
    }
    if (t.status !== 'doing') this.fm.tasks.setStatus(t.id, 'doing', { force: true });
    this.fm.setAgent(t.assignee, { taskId: t.id, state: 'thinking', station: 'desk', activity: `revising ${t.id}`, ...(t.repoId ? { repoId: t.repoId } : {}), ...(t.worktree ? { worktree: t.worktree } : {}) });
    this.enqueue({ kind: 'followup', agentId: t.assignee, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${t.assignee}:${t.id}`, prompt });
  }

  // ---- user intents -------------------------------------------------------------------------

  /** `note`: extra instructions for the agent only (not shown in the feed). */
  onUserMessage(to: string, text: string, note?: string): void {
    const id = to === 'all' ? LEAD : to;
    const a = this.fm.agent(id);
    if (!a) return;
    if (this.isStopped(id)) {
      // stays unread; delivered when the user resumes the agent (deliverPending)
      this.fm.bus.send(id, 'user', `(${this.fm.nameOf(id)} is off shift - /resume @${id} to bring them back; your message is queued.)`);
      return;
    }
    // in a turn: delivered with its next agentcraft tool result, or right after the turn ends
    // (deliverPending). Paused mid-turn: delivered with the resumed job's prompt.
    if (this.running.has(id) || this.pausedJobs.has(id)) return;
    // every unread message from the user to this agent goes into one follow-up
    const mine = this.fm.bus.inbox(id).filter((m) => m.from === 'user' && (m.to === id || (to === 'all' && m.to === 'all')));
    const body = mine.length ? mine.map((m) => m.text).join('\n\n') : text;
    const consume = () => this.fm.bus.markRead(id, mine.map((m) => m.id));
    const prompt = `Message from ${userName()}: ${body}\n\n${note ? `${note}\n\n` : ''}Respond briefly with send_message(to "user") and act on it if needed (lead: create or update tasks; worker: adjust your work).`;
    if (id === LEAD) {
      const goal = this.fm.currentGoal();
      if (!goal) {
        consume();
        this.fm.bus.send(LEAD, 'user', 'No goal yet - type one in the console and I will plan it.');
        return;
      }
      consume();
      this.enqueue({ kind: 'followup', agentId: LEAD, goalId: goal.id, sessionKey: `${LEAD}:${goal.id}`, prompt });
      return;
    }
    const t = this.fm.tasks.list().filter((x) => x.assignee === id && (x.status === 'doing' || x.status === 'review')).pop();
    consume();
    if (!t) {
      this.fm.bus.send(id, 'user', 'I am not on a task right now - Marlow will pick that up.');
      this.fm.bus.send('user', LEAD, `(for ${this.fm.nameOf(id)}) ${body}`);
      const name = this.fm.nameOf(id);
      this.onUserMessage(
        LEAD,
        `(originally for ${name}) ${body}`,
        `${name} is not on a task, and workers only read messages while they work on one. If this needs ${name} to do something, create a task for it with create_task (assignee "${id}"); a send_message alone will not reach ${name}.`,
      );
      return;
    }
    this.enqueue({ kind: 'followup', agentId: id, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${id}:${t.id}`, prompt });
  }

  onDecisionSettled(d: Decision): void {
    if (d.kind === 'question') {
      // in-process ask_user waiters resolve by themselves; after a restart nobody waits -> resume
      if (!this.waitingUser.has(d.agentId) && !this.running.has(d.agentId) && !this.isStopped(d.agentId)) {
        const ans = [d.answer?.option, d.answer?.text].filter(Boolean).join(' — ') || '(cancelled)';
        const inf = this.st.inflight[d.agentId];
        const t = d.taskId ? this.fm.tasks.get(d.taskId) : undefined;
        const goalId = inf?.goalId ?? t?.goalId ?? (d.agentId === LEAD ? this.fm.currentGoal()?.id : undefined);
        const sessionKey = inf?.sessionKey ?? (d.agentId === LEAD ? `${LEAD}:${goalId ?? 'adhoc'}` : t ? `${d.agentId}:${t.id}` : undefined);
        if (sessionKey) {
          // keep the interrupted job's kind, so its after-turn step (e.g. plan -> active) still runs
          this.enqueue({
            kind: inf?.kind ?? 'followup',
            agentId: d.agentId,
            sessionKey,
            resumed: true,
            ...(t ? { taskId: t.id } : inf?.taskId ? { taskId: inf.taskId } : {}),
            ...(goalId ? { goalId } : {}),
            prompt: `Earlier you asked ${userName()}: "${d.question}". ${userName()} answered: ${ans}. (Your ask_user call was interrupted by an orchestrator restart.) Continue.`,
          });
        }
      }
      return;
    }
    if (d.kind === 'merge' && d.taskId) {
      const t = this.fm.tasks.get(d.taskId);
      if (!t) return;
      if (d.answer?.option === 'Merge' && t.status === 'done') {
        if (t.assignee && this.fm.agent(t.assignee)?.taskId === t.id) this.fm.setAgent(t.assignee, { state: 'idle', station: 'lounge', activity: `${t.id} merged`, taskId: null, worktree: null });
        if (!this.isStopped(LEAD)) this.fm.setAgent(LEAD, { state: 'idle', station: 'meeting', activity: 'watching the task wall' });
        const g = t.goalId ? this.fm.goal(t.goalId) : undefined;
        if (g && this.fm.tasks.goalComplete(g.id)) {
          this.fm.bus.send(LEAD, 'user', `Everything for "${truncate(g.text, 80)}" is merged. Nice working with you.`);
          for (const w of this.team) if (!this.isStopped(w)) this.fm.setAgent(w, { state: 'done', station: 'lounge', activity: 'goal done' });
          if (!this.isStopped(LEAD)) this.fm.setAgent(LEAD, { state: 'done', station: 'meeting', activity: 'goal done' });
        }
        this.tick();
      } else if (d.answer?.option === 'Request changes') {
        this.sendBackToWorker(t.id, `${userName()} reviewed ${t.id} and requested changes:\n${d.answer.text ?? '(no details given - ask_user if unclear)'}\n\nMake the changes, re-run the tests, then update_task("${t.id}", status "review", summary).`);
      } else if (d.answer?.option === 'Reject') {
        if (t.assignee && this.fm.agent(t.assignee)?.taskId === t.id) this.fm.setAgent(t.assignee, { state: 'idle', station: 'lounge', activity: `${t.id} rejected`, taskId: null, worktree: null });
        this.tick();
      }
    }
  }

  onMergeConflict(task: Task, info: { base: string; branch: string; files: string[]; reason: string }): boolean {
    if (!task.assignee || this.isStopped(task.assignee)) return false; // the user decides (decision stays open)
    const files = info.files.length ? info.files.join(', ') : '(see git status)';
    this.sendBackToWorker(
      task.id,
      `${userName()} approved merging ${task.id}, but ${info.branch} now conflicts with ${info.base} (other work was merged into ${info.base} after you started) in: ${files}.\n` +
        `In your worktree run \`git merge ${info.base}\`, resolve every conflict so that both sides' changes are kept, run the tests, and commit the merge (git commit --no-edit). ` +
        `Do not rebase, reset or check out other branches. Then update_task("${task.id}", status "review", summary).`,
    );
    return true;
  }

  onTaskAction(task: Task, action: 'reassign' | 'cancel' | 'retry' | 'prioritize'): void {
    if (action === 'cancel' || action === 'reassign') {
      for (const [id, r] of this.running) {
        if (r.job.taskId === task.id && id !== LEAD && (action === 'cancel' || task.assignee !== id)) this.abortTurn(r, 'cancel');
      }
      for (const [id, q] of this.queues) this.queues.set(id, q.filter((j) => j.taskId !== task.id || (action === 'reassign' && task.assignee === id)));
      // reassigned: the new worker continues from the old worker's branch once that turn is over
      if (action === 'reassign' && task.repoId && task.worktree) {
        const wt = this.fm.repos.findWorktree(task.repoId, task.worktree);
        if (wt && wt.status === 'active' && wt.agentId !== task.assignee) this.handOff(task.id, wt.agentId, `reassigned to ${this.fm.nameOf(task.assignee ?? 'user')}`);
      }
    }
    this.tick();
  }

  /** Withdraw an agent's open questions and permission prompts (not merge decisions: those are the user's). */
  private withdrawDecisions(agentId: string, why: string): void {
    for (const d of this.fm.decisions.open().filter((x) => x.agentId === agentId && x.kind !== 'merge')) this.fm.decisions.cancel(d.id, why);
  }

  async onAgentAction(agentId: string, action: 'pause' | 'resume' | 'stop' | 'spawn'): Promise<void> {
    const r = this.running.get(agentId);
    const name = this.fm.nameOf(agentId);
    if (action === 'pause') {
      if (r) this.abortTurn(r, 'pause');
      this.fm.setAgent(agentId, { state: 'idle', activity: 'paused' });
    } else if (action === 'resume' || action === 'spawn') {
      const wasStopped = this.isStopped(agentId);
      if (action === 'spawn' && agentId !== LEAD && !this.cfg.workers.includes(agentId)) this.cfg.workers.push(agentId);
      if (wasStopped || action === 'spawn') {
        this.setStopped(agentId, false);
        this.fm.setAgent(agentId, { active: true, paused: false, state: 'idle', station: 'lounge', activity: 'ready' });
        if (wasStopped) this.fm.bus.feed('system', `${name} is back on shift`, { agentId });
      }
      const job = this.pausedJobs.get(agentId);
      this.pausedJobs.delete(agentId);
      if (job) this.enqueue(job);
      else this.pump(agentId);
      if (agentId === LEAD && wasStopped) this.reconcile();
      // messages the user sent while the agent was off shift or paused
      this.deliverPending(agentId);
    } else if (action === 'stop') {
      this.setStopped(agentId, true);
      if (r) this.abortTurn(r, 'stop');
      this.queues.delete(agentId);
      this.pausedJobs.delete(agentId);
      delete this.st.inflight[agentId];
      this.withdrawDecisions(agentId, `${name} was stopped`);
      if (agentId !== LEAD) {
        for (const t of this.fm.tasks.list().filter((x) => x.assignee === agentId && x.status === 'doing')) {
          // back on the board, but held until the agent's turn is really over and its work is committed;
          // the next worker then continues from this branch
          this.fm.tasks.setStatus(t.id, 'todo', { force: true });
          this.fm.tasks.update(t.id, { assignee: null });
          this.fm.bus.feed('task', `${t.id} is back on the board (${name} was stopped)`, { agentId: 'user' });
          this.handOff(t.id, agentId, `${name} was stopped`);
        }
      }
      this.fm.setAgent(agentId, { active: false, paused: false, state: 'idle', station: 'lounge', activity: 'stopped - off shift', taskId: null, worktree: null });
    }
    this.tick();
  }
}
