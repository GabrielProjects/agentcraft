// In-process MCP tools exposed to agents (server name "agentcraft"):
//   send_message, ask_user, write_memory, read_memory, update_task, report_status, list_tasks
//   lead only: create_task, request_merge
// Every tool result carries any unread messages for the agent (so mid-turn messages arrive).
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Foreman } from '../../foreman.js';
import { userName } from '../../user.js';
import {
  agentCraftToolNames,
  closeIfNoChanges,
  createAgentCraftHandlers,
  type ToolHooks,
  type TurnHandle,
} from '../common/tool-handlers.js';

export { closeIfNoChanges, type ToolHooks, type TurnHandle };
export const MCP_SERVER = 'agentcraft';

export function toolNames(role: 'lead' | 'worker'): string[] {
  return agentCraftToolNames(role).map((n) => `mcp__${MCP_SERVER}__${n}`);
}

export function buildMcpServer(fm: Foreman, agentId: string, role: 'lead' | 'worker', hooks: ToolHooks, turn?: TurnHandle): McpSdkServerConfigWithInstance {
  const handlers = createAgentCraftHandlers(fm, agentId, role, hooks, turn);
  const wrap = (name: string, description: string, schema: Record<string, z.ZodType>, // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): SdkMcpToolDefinition<any> =>
    tool(name, description, schema, async (args) => {
      const r = await handlers[name]!(args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Array<SdkMcpToolDefinition<any>> = [
    wrap('send_message', `Send a short message to a teammate (id or name), "lead", "all", or "user" (${userName()}; not a question — use ask_user for questions).`, {
      to: z.string().describe('agent id/name, "lead", "all" or "user"'),
      text: z.string().describe('the message (1-3 sentences)'),
    }),
    wrap(
      'ask_user',
      `Ask ${userName()} a question and WAIT for the answer. Only for decisions that are genuinely the user's. Put the recommended option first.`,
      {
        question: z.string(),
        options: z.array(z.string()).max(6).optional().describe('2-4 short choices, recommended first'),
        context: z.string().optional().describe('one or two lines of background'),
      },
    ),
    wrap('write_memory', 'Write a markdown note to memory. scope "shared" (whole team) or "private" (only you). mode "append" adds to an existing note with the same title.', {
      title: z.string(),
      body: z.string().describe('markdown'),
      scope: z.enum(['shared', 'private']).optional(),
      mode: z.enum(['replace', 'append']).optional(),
    }),
    wrap('read_memory', 'Read memory. With id: that note. With query: matching notes. With neither: list all notes you can see.', {
      id: z.string().optional(),
      query: z.string().optional(),
    }),
    wrap(
      'update_task',
      role === 'lead'
        ? 'Update a task: status (todo|doing|blocked|cancelled; "doing" on a review task = request changes), summary/feedback, assignee, title, description.'
        : 'Update YOUR task: status "review" when done (with summary of changes + testing), "blocked" with blocked_reason, or "doing".',
      {
        task_id: z.string(),
        status: z.enum(['todo', 'doing', 'review', 'blocked', 'cancelled']).optional(),
        summary: z.string().optional(),
        blocked_reason: z.string().optional(),
        assignee: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
      },
    ),
    wrap('report_status', 'Tell the team what you are doing (shown on your nameplate). One short line.', {
      activity: z.string().max(80),
      note: z.string().optional().describe('optional longer line for your monitor'),
    }),
    wrap('list_tasks', 'Show the task board (ids, status, assignee, deps).', {}),
  ];

  if (role === 'lead') {
    tools.push(
      wrap('create_task', 'Create a task for a worker. deps = task ids that must be merged first. Returns the new task id.', {
        title: z.string(),
        description: z.string().describe('what to do + acceptance criteria'),
        deps: z.array(z.string()).optional(),
        assignee: z.string().optional().describe('worker id/name'),
        priority: z.number().int().optional(),
      }),
      wrap(
        'request_merge',
        `After reviewing a task in "review": send ${userName()} a merge decision for its branch. ${userName()} decides; you do not wait.`,
        { task_id: z.string(), summary: z.string().describe(`2-4 lines for ${userName()}: what changed, how it was tested, risks`) },
      ),
    );
  }

  return createSdkMcpServer({
    name: MCP_SERVER,
    version: '0.1.0',
    tools,
    alwaysLoad: true,
    instructions: `AgentCraft team tools: coordinate with teammates, ask ${userName()}, keep memory and the task board up to date.`,
  });
}
