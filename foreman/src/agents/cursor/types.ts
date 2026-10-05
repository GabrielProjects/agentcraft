// Minimal Cursor SDK shapes used by the Cursor backend (avoids a hard type dependency at compile time).

export type CursorToolName =
  | 'shell'
  | 'read'
  | 'write'
  | 'edit'
  | 'grep'
  | 'glob'
  | 'ls'
  | 'delete'
  | 'webSearch'
  | 'webFetch'
  | 'task'
  | 'mcp'
  | string;

export interface CursorModelSelection {
  id: string;
}

export interface CursorCustomTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context?: { toolCallId?: string; sessionId?: string }) => unknown | Promise<unknown>;
}

export interface CursorLocalOptions {
  cwd: string;
  store?: unknown;
  settingSources?: Array<'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'>;
  customTools?: Record<string, CursorCustomTool>;
}

export interface CursorAgentOptions {
  apiKey?: string;
  model: CursorModelSelection;
  local: CursorLocalOptions;
  systemPrompt?: string;
  tools?: CursorToolName[];
  disallowedTools?: CursorToolName[];
}

export interface CursorRunResult {
  id?: string;
  status: 'finished' | 'error' | 'cancelled' | string;
  result?: string;
  usage?: { totalTokens?: number; totalCostUsd?: number };
}

export interface CursorRun {
  id?: string;
  stream(): AsyncIterable<CursorSDKMessage>;
  wait(): Promise<CursorRunResult>;
  cancel?(): Promise<void>;
  supports?(op: string): boolean;
}

export interface CursorAgent {
  agentId: string;
  send(prompt: string, opts?: { local?: Partial<CursorLocalOptions> }): Promise<CursorRun>;
  close?(): void | Promise<void>;
}

export type CursorSDKMessage =
  | { type: 'system'; subtype?: string; agent_id?: string; run_id?: string; model?: CursorModelSelection | string; tools?: string[] }
  | { type: 'user'; agent_id?: string; run_id?: string; message?: { role?: string; content?: unknown } }
  | { type: 'assistant'; agent_id?: string; run_id?: string; message?: { role?: string; content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> } }
  | { type: 'thinking'; agent_id?: string; run_id?: string; text?: string }
  | { type: 'tool_call'; agent_id?: string; run_id?: string; call_id: string; name: string; status: 'running' | 'completed' | 'error' | string; args?: unknown; result?: unknown }
  | { type: 'status'; agent_id?: string; run_id?: string; status?: string; message?: string }
  | { type: 'task'; agent_id?: string; run_id?: string; status?: string; text?: string }
  | { type: 'usage'; agent_id?: string; run_id?: string; usage?: { totalTokens?: number; totalCostUsd?: number } }
  | { type: 'request'; agent_id?: string; run_id?: string; request_id?: string }
  | { type: string; [k: string]: unknown };

export type CreateAgentFn = (opts: CursorAgentOptions) => Promise<CursorAgent>;
export type ResumeAgentFn = (agentId: string, opts: CursorAgentOptions) => Promise<CursorAgent>;
