# Cursor backend

AgentCraft can drive the same Minecraft studio with **Cursor agents** instead of the Claude Agent SDK.

## Prerequisites

- Node 22.13+ (Foreman requirement; Cursor SDK needs ≥22.13)
- A Cursor API key from [Dashboard → Integrations](https://cursor.com/dashboard/integrations)
- Optional npm package `@cursor/sdk` (declared as an optional dependency of `foreman/`)

```powershell
setx CURSOR_API_KEY "cursor_..."
# open a new terminal so the env var is visible
```

## Launch

```powershell
tools\launch.ps1 -Backend cursor -Repo C:\path\to\your\repo
```

macOS:

```sh
node tools/mac.mjs launch --backend cursor --repo /path/to/your/repo
```

Foreman-only:

```powershell
cd foreman
npm start -- --backend cursor --repo C:\path\to\your\repo
```

## Configuration

CLI / env / `~/.agentcraft/config.json`:

```json
{
  "backend": "cursor",
  "cursor": {
    "leadModel": "auto",
    "workerModel": "auto",
    "workers": ["juniper", "kit", "wren"],
    "maxConcurrent": 3,
    "resumeOnStart": true,
    "leadReview": true
  }
}
```

- `--model`, `--lead-model`, `--worker-model` set Cursor model ids (use ids from your account; default `auto`).
- `--workers`, `--max-concurrent`, `--ci`, `--no-lead-review`, `--no-resume` work like the Claude backend.
- Default Foreman backend remains `claude` when `-Backend` is omitted.

## How it fits

| Piece | Owner |
|-------|--------|
| Minecraft UI, protocol, decisions, merge | Unchanged |
| Task graph, RepoManager worktrees, CI, git safety | Foreman core |
| Agent planning / coding turns | `CursorBackend` via `@cursor/sdk` local runtime |
| AgentCraft tools (create_task, ask_user, …) | `local.customTools` → shared handlers |
| Permissions | Project hooks + local bridge → `policy.ts` |

Each worker still receives a RepoManager worktree as `cwd`. Merges still require your in-game approval. `git push` remains blocked by `gitsafety.ts`.

## Authentication

Only `CURSOR_API_KEY` is supported (user or team service-account keys). There is no GUI login path for the Foreman.

## Models

Do not copy Claude model names (`opus` / `sonnet`) into the Cursor config. Prefer `auto` or an id returned by Cursor for your account.

## Costs / usage

If the SDK reports token usage, `/status` shows it. Otherwise AgentCraft reports that usage is unavailable for the Cursor backend (it does not invent numbers).

## Security

- Same Foreman git-safety environment as Claude (no push transports, no signing, ceiling directories).
- Shell / tool calls go through AgentCraft hooks that call `policy.ts` (allow / deny / ask in Minecraft).
- Agents must not merge to the main branch themselves; only `request_merge` → your Merge click → RepoManager.

## Limitations

- Hooks are file-based under each worktree’s `.cursor/` (can coexist with other project hooks; AgentCraft merges its entries).
- Mid-turn user messages are delivered via tool-result inbox and/or a follow-up turn (same semantics as Claude, different transport).
- `@cursor/sdk` is optional: `sim` and `claude` backends do not require it.
- Local SDK agents inherit process environment; Foreman applies git-safety before runs. Prefer `maxConcurrent: 1` if you need strict per-agent git identity isolation.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Launcher: `CURSOR_API_KEY is not set` | Export the key in this shell / use `setx` and open a new terminal |
| Auth failed banner | Check the key at cursor.com/dashboard/integrations; restart Foreman |
| `Cannot find package '@cursor/sdk'` | `cd foreman && npm install` (optional dependency) |
| Agents idle after goal | Check Foreman log under `artifacts/logs/`; confirm repo path and git |
| Permission loops | Answer (or Deny) the in-game permission prompt; check hook bridge port in worktree `.cursor/hooks/` |

## Related

- [foreman/README.md](../foreman/README.md) — orchestrator overview
- [docs/protocol.md](protocol.md) — WebSocket protocol (provider-agnostic)
