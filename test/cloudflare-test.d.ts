// Minimal ambient types for the `cloudflare:test` module used by
// @cloudflare/vitest-pool-workers. Kept intentionally loose (the test
// files narrow what they need) rather than depending on generated
// wrangler types, so this project doesn't require an extra codegen step
// before tests can typecheck.
declare module "cloudflare:test" {
  export const env: {
    INCIDENT_ROOM: DurableObjectNamespace;
  };

  export const SELF: {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
  };

  export function runInDurableObject<T>(
    stub: DurableObjectStub,
    callback: (instance: any, state: DurableObjectState) => Promise<T> | T
  ): Promise<T>;
}
