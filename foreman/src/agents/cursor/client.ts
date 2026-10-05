// Lazy loader for @cursor/sdk so sim/claude backends work without the package installed.
import path from 'node:path';
import type { CreateAgentFn, CursorAgent, CursorAgentOptions, ResumeAgentFn } from './types.js';

const MISSING_SDK =
  '@cursor/sdk is not installed. Run `npm install @cursor/sdk` in the foreman package, then restart the Foreman.';

let sdkPromise: Promise<{ Agent: CursorSdkAgentStatic; JsonlLocalAgentStore: new (dir: string) => unknown }> | undefined;

interface CursorSdkAgentStatic {
  create(opts: CursorAgentOptions): Promise<CursorAgent>;
  resume(agentId: string, opts: CursorAgentOptions): Promise<CursorAgent>;
}

async function loadSdk(): Promise<{ Agent: CursorSdkAgentStatic; JsonlLocalAgentStore: new (dir: string) => unknown }> {
  if (!sdkPromise) {
    sdkPromise = import('@cursor/sdk')
      .then((m) => {
        const Agent = (m as { Agent?: CursorSdkAgentStatic }).Agent;
        const JsonlLocalAgentStore = (m as { JsonlLocalAgentStore?: new (dir: string) => unknown }).JsonlLocalAgentStore;
        if (!Agent?.create || !Agent.resume || !JsonlLocalAgentStore) {
          throw new Error('@cursor/sdk loaded but Agent.create / Agent.resume / JsonlLocalAgentStore are missing');
        }
        return { Agent, JsonlLocalAgentStore };
      })
      .catch((e) => {
        sdkPromise = undefined;
        const msg = (e as Error).message ?? String(e);
        if (/Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package/i.test(msg)) throw new Error(MISSING_SDK);
        throw e;
      });
  }
  return sdkPromise;
}

export async function createLocalAgent(opts: CursorAgentOptions, createFn?: CreateAgentFn): Promise<CursorAgent> {
  if (createFn) return createFn(opts);
  const { Agent, JsonlLocalAgentStore } = await loadSdk();
  const storeDir = path.join(opts.local.cwd, '.agentcraft', 'cursor-store');
  return Agent.create({
    ...opts,
    local: {
      ...opts.local,
      store: opts.local.store ?? new JsonlLocalAgentStore(storeDir),
    },
  });
}

export async function resumeLocalAgent(agentId: string, opts: CursorAgentOptions, resumeFn?: ResumeAgentFn): Promise<CursorAgent> {
  if (resumeFn) return resumeFn(agentId, opts);
  const { Agent, JsonlLocalAgentStore } = await loadSdk();
  const storeDir = path.join(opts.local.cwd, '.agentcraft', 'cursor-store');
  return Agent.resume(agentId, {
    ...opts,
    local: {
      ...opts.local,
      store: opts.local.store ?? new JsonlLocalAgentStore(storeDir),
    },
  });
}
