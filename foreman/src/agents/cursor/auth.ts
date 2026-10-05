// Cursor SDK auth for the Cursor backend.
export type CursorAuth = { ok: true; source: string } | { ok: false };

/** Which Cursor authentication the environment provides, if any. */
export function detectCursorAuth(env: NodeJS.ProcessEnv = process.env): CursorAuth {
  if (env.CURSOR_API_KEY?.trim()) return { ok: true, source: 'CURSOR_API_KEY' };
  return { ok: false };
}

export const NO_CURSOR_AUTH_MESSAGE =
  'No Cursor API key. Set CURSOR_API_KEY (from cursor.com/dashboard/integrations), then restart the Foreman. ' +
  'The sim and claude backends work without it.';
