// Cursor `local.customTools` exposing the same AgentCraft tools as Claude's MCP server.
import type { Foreman } from '../../foreman.js';
import { userName } from '../../user.js';
import { closeIfNoChanges, createAgentCraftHandlers, type ToolHooks, type TurnHandle } from '../common/tool-handlers.js';
import type { CursorCustomTool } from './types.js';

export { closeIfNoChanges, type ToolHooks, type TurnHandle };

const str = (desc: string) => ({ type: 'string', description: desc });
const strOpt = (desc: string) => ({ type: 'string', description: desc });
const arrStr = (desc: string) => ({ type: 'array', items: { type: 'string' }, description: desc });

function mcpResult(text: string, isError?: boolean): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** Build Cursor customTools for the AgentCraft coordination surface. */
export function buildCustomTools(fm: Foreman, agentId: string, role: 'lead' | 'worker', hooks: ToolHooks, turn?: TurnHandle): Record<string, CursorCustomTool> {
  const handlers = createAgentCraftHandlers(fm, agentId, role, hooks, turn);
  const exec = (name: string): CursorCustomTool['execute'] => async (args) => {
    const r = await handlers[name]!(args);
    return mcpResult(r.text, r.isError);
  };

  const tools: Record<string, CursorCustomTool> = {
    send_message: {
      description: `Send a short message to a teammate (id or name), "lead", "all", or "user" (${userName()}; not a question — use ask_user for questions).`,
      inputSchema: {
        type: 'object',
        properties: { to: str('agent id/name, "lead", "all" or "user"'), text: str('the message (1-3 sentences)') },
        required: ['to', 'text'],
      },
      execute: exec('send_message'),
    },
    ask_user: {
      description: `Ask ${userName()} a question and WAIT for the answer. Only for decisions that are genuinely the user's. Put the recommended option first.`,
      inputSchema: {
        type: 'object',
        properties: {
          question: str('the question'),
          options: arrStr('2-4 short choices, recommended first'),
          context: strOpt('one or two lines of background'),
        },
        required: ['question'],
      },
      execute: exec('ask_user'),
    },
    write_memory: {
      description: 'Write a markdown note to memory. scope "shared" (whole team) or "private" (only you). mode "append" adds to an existing note with the same title.',
      inputSchema: {
        type: 'object',
        properties: {
          title: str('title'),
          body: str('markdown'),
          scope: { type: 'string', enum: ['shared', 'private'] },
          mode: { type: 'string', enum: ['replace', 'append'] },
        },
        required: ['title', 'body'],
      },
      execute: exec('write_memory'),
    },
    read_memory: {
      description: 'Read memory. With id: that note. With query: matching notes. With neither: list all notes you can see.',
      inputSchema: {
        type: 'object',
        properties: { id: strOpt('memory id'), query: strOpt('search query') },
      },
      execute: exec('read_memory'),
    },
    update_task: {
      description:
        role === 'lead'
          ? 'Update a task: status (todo|doing|blocked|cancelled; "doing" on a review task = request changes), summary/feedback, assignee, title, description.'
          : 'Update YOUR task: status "review" when done (with summary of changes + testing), "blocked" with blocked_reason, or "doing".',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: str('task id'),
          status: { type: 'string', enum: ['todo', 'doing', 'review', 'blocked', 'cancelled'] },
          summary: strOpt('summary'),
          blocked_reason: strOpt('blocked reason'),
          assignee: strOpt('assignee'),
          title: strOpt('title'),
          description: strOpt('description'),
        },
        required: ['task_id'],
      },
      execute: exec('update_task'),
    },
    report_status: {
      description: 'Tell the team what you are doing (shown on your nameplate). One short line.',
      inputSchema: {
        type: 'object',
        properties: { activity: str('short activity'), note: strOpt('optional longer note') },
        required: ['activity'],
      },
      execute: exec('report_status'),
    },
    list_tasks: {
      description: 'Show the task board (ids, status, assignee, deps).',
      inputSchema: { type: 'object', properties: {} },
      execute: exec('list_tasks'),
    },
  };

  if (role === 'lead') {
    tools.create_task = {
      description: 'Create a task for a worker. deps = task ids that must be merged first. Returns the new task id.',
      inputSchema: {
        type: 'object',
        properties: {
          title: str('title'),
          description: str('what to do + acceptance criteria'),
          deps: arrStr('task ids that must be merged first'),
          assignee: strOpt('worker id/name'),
          priority: { type: 'integer', description: 'priority' },
        },
        required: ['title', 'description'],
      },
      execute: exec('create_task'),
    };
    tools.request_merge = {
      description: `After reviewing a task in "review": send ${userName()} a merge decision for its branch. ${userName()} decides; you do not wait.`,
      inputSchema: {
        type: 'object',
        properties: {
          task_id: str('task id'),
          summary: str(`2-4 lines for ${userName()}: what changed, how it was tested, risks`),
        },
        required: ['task_id', 'summary'],
      },
      execute: exec('request_merge'),
    };
  }

  return tools;
}
