declare module '@cursor/sdk' {
  // Ambient stub so TypeScript accepts the dynamic import without requiring the package at compile time.
  export const Agent: {
    create(opts: unknown): Promise<unknown>;
    resume(agentId: string, opts: unknown): Promise<unknown>;
  };
  export class JsonlLocalAgentStore {
    constructor(dir: string);
  }
}
