// Shared AgentCraft tool logic for Claude (MCP) and Cursor (customTools) backends.
import { formatInbox } from '../../bus.js';
import type { Foreman } from '../../foreman.js';
import type { AgentState, Decision, TaskStatus } from '../../protocol.js';
import { MERGE_OPTIONS } from '../../protocol.js';
import { truncate } from '../../util/text.js';
import { boardSummary } from './prompts.js';
import { userName } from '../../user.js';

export interface ToolHooks {
  /** worker moved its task to review */
  onReview(agentId: string, taskId: string): void;
  /** lead asked for changes on a task (status -> doing) */
  onChangesRequested(taskId: string, feedback: string): void;
  /** a task was created (scheduler tick) */
  onTasksChanged(): void;
  /** lead requested a merge (decision created) */
  onMergeRequested(taskId: string, decision: Decision): void;
  /** agent is blocked waiting for the user */
  onWaiting(agentId: string, waiting: boolean): void;
}

/** The turn a tool server belongs to: once it is aborted, tools refuse to act. */
export interface TurnHandle {
  signal: AbortSignal;
  /** why it was aborted: pause | stop | shutdown | cancel | timeout */
  reason(): string | undefined;
}

export type ToolTextResult = { text: string; isError?: boolean };

/**
 * A task in review whose worktree changed nothing (a report, an investigation): there is nothing
 * to merge, so it is closed as done (worktree abandoned, branch kept) instead of asking the user to
 * approve an empty merge. Returns true if it was closed.
 */
export async function closeIfNoChanges(fm: Foreman, taskId: string): Promise<boolean> {
  const t = fm.tasks.get(taskId);
  if (!t || t.status !== 'review' || !t.repoId || !t.worktree) return false;
  await fm.repos.refresh(t.repoId);
  const wt = fm.repos.findWorktree(t.repoId, t.worktree);
  if (!wt || wt.status !== 'active' || wt.files > 0) return false;
  await fm.repos.abandon(t.repoId, wt.id, `agentcraft: ${t.id} (no changes)`);
  fm.tasks.setStatus(t.id, 'done', { force: true, summary: t.summary ?? 'no changes' });
  fm.bus.feed('task', `${t.id} changed no files (report only): closed as done, nothing to merge`, { agentId: t.assignee ?? 'marlow' });
  if (t.assignee && fm.agent(t.assignee)?.taskId === t.id) fm.setAgent(t.assignee, { state: 'idle', station: 'lounge', activity: `${t.id} done`, taskId: null, worktree: null });
  return true;
}

export function agentCraftToolNames(role: 'lead' | 'worker'): string[] {
  const common = ['send_message', 'ask_user', 'write_memory', 'read_memory', 'update_task', 'report_status', 'list_tasks'];
  const lead = role === 'lead' ? ['create_task', 'request_merge'] : [];
  return [...common, ...lead];
}

type Args = Record<string, unknown>;

/** In-process AgentCraft tool handlers (plain text results). */
export function createAgentCraftHandlers(
  fm: Foreman,
  agentId: string,
  role: 'lead' | 'worker',
  hooks: ToolHooks,
  turn?: TurnHandle,
): Record<string, (args: Args) => Promise<ToolTextResult>> {
  const withInbox = (text: string, isError = false): ToolTextResult => {
    const inbox = fm.bus.inbox(agentId, { markRead: true });
    const extra = inbox.length ? `\n\n[New messages]\n${formatInbox(inbox, (id) => fm.nameOf(id))}` : '';
    return { text: text + extra, ...(isError ? { isError: true } : {}) };
  };
  const fail = (text: string) => withInbox(`Error: ${text}`, true);
  const guard = async (fn: (args: Args) => Promise<ToolTextResult>, args: Args): Promise<ToolTextResult> => {
    if (turn?.signal.aborted) return fail('your turn was stopped; nothing was changed');
    return fn(args);
  };

  const handlers: Record<string, (args: Args) => Promise<ToolTextResult>> = {
    send_message: (args) =>
      guard(async ({ to, text }) => {
        let target = String(to ?? '').trim().toLowerCase();
        const message = String(text ?? '');
        if (target === 'lead') target = 'marlow';
        if (!['all', 'user'].includes(target)) {
          const id = fm.resolveAgentId(target);
          if (!id) return fail(`no teammate "${to}". Team: ${fm.agents().filter((a) => a.active).map((a) => a.id).join(', ')}`);
          target = id;
        }
        if (target === agentId) return fail('you cannot message yourself');
        fm.bus.send(agentId, target, message);
        if (role === 'lead' && !['all', 'user'].includes(target) && !fm.agent(target)?.taskId) {
          return withInbox(
            `Sent to ${target}, but ${fm.nameOf(target)} is not on a task, so they will only read it when their next task starts. ` +
              `To have ${fm.nameOf(target)} do something now, create a task for it with create_task (assignee "${target}").`,
          );
        }
        return withInbox(`Sent to ${target}.`);
      }, args),

    ask_user: (args) =>
      guard(async ({ question, options, context }) => {
        const prev = fm.agent(agentId);
        const home = role === 'lead' ? 'meeting' : 'desk';
        const waiting = prev?.state === 'waiting_user' || prev?.station === 'user';
        const prevState = { state: waiting ? 'thinking' : (prev?.state ?? 'thinking'), station: waiting ? home : (prev?.station ?? home), activity: prev?.activity ?? '' };
        const d = fm.createDecision({
          agentId,
          kind: 'question',
          question: String(question ?? ''),
          options: Array.isArray(options) ? options.map(String) : [],
          ...(typeof context === 'string' ? { context } : {}),
          ...(prev?.taskId ? { taskId: prev.taskId } : {}),
        });
        fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'waiting for your answer' });
        hooks.onWaiting(agentId, true);
        const onAbort = () => {
          if (turn?.reason() !== 'shutdown') fm.decisions.cancel(d.id, `${fm.nameOf(agentId)}'s turn was stopped`);
        };
        if (turn?.signal.aborted) onAbort();
        else turn?.signal.addEventListener('abort', onAbort, { once: true });
        const done = await fm.decisions.wait(d.id);
        turn?.signal.removeEventListener('abort', onAbort);
        hooks.onWaiting(agentId, false);
        if (turn?.signal.aborted) return withInbox(`Your turn was stopped before ${userName()} answered.`, true);
        fm.setAgent(agentId, { state: prevState.state as AgentState, station: prevState.station, activity: 'got your answer' });
        if (done.status === 'cancelled') return withInbox('The question was cancelled. Use your best judgement and note the assumption.');
        const ans = [done.answer?.option, done.answer?.text].filter(Boolean).join(' — ');
        return withInbox(`${userName()} answered: ${ans}`);
      }, args),

    write_memory: (args) =>
      guard(async ({ title, body, scope, mode }) => {
        const e = fm.memory.write({
          scope: scope === 'private' ? agentId : 'shared',
          title: String(title ?? ''),
          body: String(body ?? ''),
          author: agentId,
          mode: mode === 'append' ? 'append' : 'replace',
        });
        fm.bus.feed('memory', `${fm.nameOf(agentId)} wrote memory: ${e.title}`, { agentId });
        return withInbox(`Saved memory ${e.id}.`);
      }, args),

    read_memory: (args) =>
      guard(async ({ id, query }) => {
        if (typeof id === 'string' && id) {
          const e = fm.memory.get(id) ?? fm.memory.get(`shared/${id}`) ?? fm.memory.get(`${agentId}/${id}`);
          if (!e || (e.scope !== 'shared' && e.scope !== agentId)) return fail(`no memory ${id}`);
          return withInbox(`# ${e.title} (${e.id})\n\n${e.body}`);
        }
        const q = typeof query === 'string' ? query : undefined;
        const list = q ? fm.memory.search(q, agentId) : fm.memory.visibleTo(agentId);
        if (!list.length) return withInbox('No memory notes.');
        if (q && list.length <= 3) return withInbox(list.map((e) => `# ${e.title} (${e.id})\n\n${truncate(e.body, 3000)}`).join('\n\n---\n\n'));
        return withInbox(list.map((e) => `- ${e.id}: ${e.title}`).join('\n'));
      }, args),

    update_task: (args) =>
      guard(async (a) => {
        const taskId = String(a.task_id ?? '');
        const t = fm.tasks.get(taskId);
        if (!t) return fail(`no task ${taskId}. ${boardSummary(fm)}`);
        if (role === 'worker') {
          const current = fm.agent(agentId)?.taskId;
          if (t.assignee !== agentId) return fail(`${t.id} is not your task`);
          if (current && t.id !== current) return fail(`you are working on ${current}; you can only update that task. Tell Marlow (send_message to "lead") if ${t.id} is already covered.`);
          if (a.status && !['review', 'blocked', 'doing'].includes(String(a.status))) return fail('workers can set status review, blocked or doing');
          if (a.assignee || a.title || a.description) return fail('only the lead can change assignee/title/description');
        }
        try {
          if (typeof a.assignee === 'string') {
            const id = fm.resolveAgentId(a.assignee);
            if (!id) return fail(`no agent ${a.assignee}`);
            fm.tasks.update(t.id, { assignee: id });
          }
          if (typeof a.title === 'string') fm.tasks.update(t.id, { title: a.title });
          if (typeof a.description === 'string') fm.tasks.update(t.id, { description: a.description });
          if (typeof a.summary === 'string') fm.tasks.update(t.id, { summary: a.summary });
          if (typeof a.status === 'string' && a.status !== t.status) {
            const prev = t.status;
            const status = a.status as TaskStatus;
            fm.tasks.setStatus(t.id, status, {
              force: role === 'lead' || status === 'review',
              ...(typeof a.blocked_reason === 'string' ? { reason: a.blocked_reason } : {}),
              ...(typeof a.summary === 'string' ? { summary: a.summary } : {}),
            });
            fm.bus.feed('task', `${fm.nameOf(agentId)}: ${t.id} ${prev} -> ${a.status}`, { agentId });
            if (status === 'review' && role === 'worker') hooks.onReview(agentId, t.id);
            if (status === 'doing' && prev === 'review' && role === 'lead') hooks.onChangesRequested(t.id, typeof a.summary === 'string' ? a.summary : 'see review comments');
          }
          hooks.onTasksChanged();
          return withInbox(`Updated ${t.id}: ${fm.tasks.get(t.id)!.status}.`);
        } catch (e) {
          return fail((e as Error).message);
        }
      }, args),

    report_status: (args) =>
      guard(async ({ activity, note }) => {
        fm.setAgent(agentId, { activity: String(activity ?? '').slice(0, 80) });
        if (typeof note === 'string' && note) fm.agentLog(agentId, 'text', note);
        return withInbox('ok');
      }, args),

    list_tasks: (args) => guard(async () => withInbox(boardSummary(fm)), args),
  };

  if (role === 'lead') {
    handlers.create_task = (args) =>
      guard(async ({ title, description, deps, assignee, priority }) => {
        const goal = fm.currentGoal();
        let who: string | undefined;
        if (typeof assignee === 'string' && assignee) {
          who = fm.resolveAgentId(assignee);
          if (!who) return fail(`no worker ${assignee}`);
          if (fm.agent(who)?.role === 'lead') return fail('assign tasks to workers, not yourself');
        }
        try {
          const t = fm.tasks.create({
            title: String(title ?? ''),
            description: String(description ?? ''),
            deps: Array.isArray(deps) ? deps.map(String) : [],
            ...(who ? { assignee: who } : {}),
            ...(typeof priority === 'number' ? { priority } : {}),
            createdBy: agentId,
            ...(goal ? { goalId: goal.id } : {}),
            ...(goal?.repoId ? { repoId: goal.repoId } : {}),
          });
          fm.bus.feed('task', `Marlow created ${t.id}: ${t.title}`, { agentId });
          hooks.onTasksChanged();
          return withInbox(`Created ${t.id}.`);
        } catch (e) {
          return fail((e as Error).message);
        }
      }, args);

    handlers.request_merge = (args) =>
      guard(async ({ task_id, summary }) => {
        const t = fm.tasks.get(String(task_id ?? ''));
        if (!t) return fail(`no task ${task_id}`);
        if (t.status !== 'review') return fail(`${t.id} is ${t.status}, not in review`);
        if (!t.worktree || !t.repoId) return fail(`${t.id} has no worktree to merge`);
        const open = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === t.id);
        if (open) return withInbox(`Merge decision ${open.id} for ${t.id} is already waiting for ${userName()}.`);
        if (await closeIfNoChanges(fm, t.id)) {
          hooks.onTasksChanged();
          return withInbox(`${t.id} changed no files, so there is nothing to merge: it is closed as done. Tell ${userName()} the result with send_message if you have not yet.`);
        }
        const wt = fm.repos.requireWorktree(t.repoId, t.worktree);
        const d = fm.createDecision({
          agentId,
          kind: 'merge',
          question: `Merge ${t.id} "${t.title}" (${wt.branch}) into ${wt.base}?`,
          options: [...MERGE_OPTIONS],
          context: `${String(summary ?? '')}\n${wt.files} files, +${wt.additions} -${wt.deletions} | tests: ${t.ci}`,
          taskId: t.id,
          repoId: t.repoId,
          worktree: wt.id,
        });
        hooks.onMergeRequested(t.id, d);
        return withInbox(`Merge decision ${d.id} sent to ${userName()}.`);
      }, args);
  }

  return handlers;
}
