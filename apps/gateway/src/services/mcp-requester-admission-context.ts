import { mcpRequesterAdmissionScopeSchema, type McpRequesterAdmissionScope } from "@goatcitadel/contracts";
import { McpRequesterResolutionError } from "./mcp-requester-resolution.js";
import type { McpRequesterScopedTurnContextHandle } from "./mcp-requester-resolution-service.js";

const brand: unique symbol = Symbol("mcp.admission.context");
const contexts = new WeakMap<
  object,
  Readonly<{ scope: McpRequesterAdmissionScope; referenceSha256: string; assertCurrent(): Promise<void> }>
>();
export interface McpRequesterAdmissionTurnContextHandle {
  readonly [brand]: true;
  toJSON(): never;
}
export type McpChatTurnContextHandle = McpRequesterScopedTurnContextHandle | McpRequesterAdmissionTurnContextHandle;

/** Minted only from server-owned admitted feature references. Reading the handle grants no authority. */
export function createMcpRequesterAdmissionTurnContext(
  scope: McpRequesterAdmissionScope,
  referenceSha256: string,
  assertCurrent: () => Promise<void>,
): McpRequesterAdmissionTurnContextHandle {
  const parsed = mcpRequesterAdmissionScopeSchema.parse(scope);
  if (!/^[a-f0-9]{64}$/u.test(referenceSha256) || typeof assertCurrent !== "function")
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  const handle = Object.freeze({
    [brand]: true as const,
    toJSON(): never {
      throw new McpRequesterResolutionError("requester_context_ambiguous");
    },
  });
  contexts.set(handle, Object.freeze({ scope: Object.freeze(parsed), referenceSha256, assertCurrent }));
  return handle;
}

export function readMcpRequesterAdmissionTurnContext(
  handle: unknown,
): { scope: McpRequesterAdmissionScope; referenceSha256: string; assertCurrent(): Promise<void> } | undefined {
  if (!handle || typeof handle !== "object") return undefined;
  const value = contexts.get(handle);
  return value
    ? { scope: { ...value.scope }, referenceSha256: value.referenceSha256, assertCurrent: value.assertCurrent }
    : undefined;
}
