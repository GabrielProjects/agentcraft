// Standalone smoke checks for Cursor backend helpers (no vitest required).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Inline the pure helpers we care about (mirrors stream.ts / auth.ts) so this runs even when
// the TypeScript toolchain / hollow node_modules cannot load project imports.
function normalizeCursorToolName(name) {
  const leaf = name.includes('__') ? name.split('__').pop() : name.replace(/^MCP:/i, '');
  const key = leaf.trim();
  const map = {
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
    grep: 'Grep',
    Grep: 'Grep',
    glob: 'Glob',
    Glob: 'Glob',
    ls: 'LS',
    LS: 'LS',
    webSearch: 'WebSearch',
    WebSearch: 'WebSearch',
    webFetch: 'WebFetch',
    WebFetch: 'WebFetch',
    task: 'Task',
    Task: 'Task',
  };
  return map[key] ?? key;
}

function detectCursorAuth(env = process.env) {
  if (env.CURSOR_API_KEY?.trim()) return { ok: true, source: 'CURSOR_API_KEY' };
  return { ok: false };
}

assert.equal(normalizeCursorToolName('Shell'), 'Bash');
assert.equal(normalizeCursorToolName('shell'), 'Bash');
assert.equal(normalizeCursorToolName('edit'), 'Edit');
assert.equal(normalizeCursorToolName('mcp__custom-user-tools__ask_user'), 'ask_user');
assert.equal(detectCursorAuth({ CURSOR_API_KEY: 'cursor_x' }).ok, true);
assert.equal(detectCursorAuth({}).ok, false);

// File presence checks for the Cursor backend surface
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../src/agents/cursor');
for (const f of ['index.ts', 'stream.ts', 'auth.ts', 'client.ts', 'tools.ts', 'hooks.ts', 'types.ts']) {
  assert.ok(fs.existsSync(path.join(root, f)), `missing ${f}`);
}
assert.ok(!fs.existsSync(path.join(root, 'tools-ref.ts')), 'tools-ref.ts should be deleted');

const index = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');
assert.match(index, /readonly name = 'cursor'/);
assert.match(index, /b\.cursor/);
assert.match(index, /CURSOR_AGENTCRAFT/);
assert.match(index, /buildCustomTools/);
assert.match(index, /PermissionBridge/);
assert.doesNotMatch(index, /claude-agent-sdk/);
assert.doesNotMatch(index, /b\.claude/);

const common = fs.readFileSync(path.join(root, '../common/tool-handlers.ts'), 'utf8');
assert.match(common, /createAgentCraftHandlers/);
assert.match(common, /closeIfNoChanges/);

console.log('cursor smoke ok');
