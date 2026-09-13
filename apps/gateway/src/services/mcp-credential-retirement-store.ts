import { createHash } from "node:crypto";
import { ConflictError } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { AsyncStorage } from "@goatcitadel/storage";
import { isMcpOAuthTokenRefForServer } from "./mcp-oauth-token-service.js";
import { isMcpEnvironmentRefForServer } from "./mcp-static-environment-service.js";

const INDEX = "mcp_credential_retirements_v1";
const PREFIX = "mcp_credential_retired_v1:";
const SECRET_PREFIX = "keychain:goatcitadel:";
const MAX_PENDING = 4096;
const KEY = /^mcp_credential_retired_v1:[a-f0-9]{64}$/u;
type Retirement = {
  version: 2;
  custodyId: string | null;
  serverId: string;
  credentialRef: string;
  retiredAt: string;
  status: "pending" | "deleting" | "deleted";
};
export type McpCredentialMetadataContext = {
  systemSettings: Pick<AsyncStorage["systemSettings"], "get" | "compareAndSet">;
  runImmediateTransaction: AsyncStorage["runImmediateTransaction"];
};
export interface McpCredentialReconciliationResult {
  deleted: number;
  blocked: number;
  failed: number;
  remaining: number;
}

/** Private credential metadata only. Publication and retirement share the
 * registry's transaction; immutable tombstones prevent a deleted version from
 * being published again. No provider request or credential value belongs here. */
export class McpCredentialRetirementStore {
  constructor(private readonly ctx: McpCredentialMetadataContext,
    private readonly resolveCustody: (serverId: string, ref: string) => Promise<string | null> = async () => null) {}

  async assertPublishable(serverId: string, refs: readonly (string | undefined)[]): Promise<void> {
    for (const ref of unique(refs)) {
      assertOwned(serverId, ref);
      if (await this.ctx.systemSettings.get(keyFor(ref)))
        throw new ConflictError({ message: "MCP credential version was retired; reconnect with fresh credentials." });
    }
  }

  /** Must run inside the canonical auth/environment publication transaction. */
  async record(serverId: string, previous: readonly (string | undefined)[], next: readonly (string | undefined)[]): Promise<void> {
    const oldRefs = unique(previous), newRefs = unique(next);
    await this.ctx.runImmediateTransaction(() => this.recordWithinTransaction(serverId, oldRefs, newRefs));
  }

  private async recordWithinTransaction(serverId: string, previous: readonly string[], next: readonly string[]): Promise<void> {
    const retained = new Set(unique(next));
    for (const ref of unique(previous)) {
      if (!isOwned(serverId, ref)) {
        // A reconnect may repair a corrupt cross-server binding. Preserve that
        // unrelated credential instead of making its deletion part of repair.
        logger.warn("MCP retirement left an invalid prior credential reference untouched.");
        continue;
      }
      if (retained.has(ref)) continue;
      const key = keyFor(ref);
      const prior = await this.ctx.systemSettings.get<Retirement>(key);
      if (prior) {
        requireRetirement(key, prior.value);
        continue;
      }
      const custodyId = await this.resolveCustody(serverId, ref);
      if (custodyId !== null && (typeof custodyId !== "string" || !/^[a-f0-9]{64}$/u.test(custodyId))) throw conflict();
      const entry: Retirement = { version: 2, custodyId, serverId, credentialRef: ref,
        retiredAt: new Date().toISOString(), status: "pending" };
      if (!(await this.ctx.systemSettings.compareAndSet(key, undefined, entry))) throw conflict();
      const index = await this.ctx.systemSettings.get(INDEX);
      const keys = requireIndex(index?.value);
      if (keys.length >= MAX_PENDING) throw new ConflictError({ message: "MCP credential cleanup backlog requires reconciliation." });
      if (!(await this.ctx.systemSettings.compareAndSet(INDEX, index, { version: 1, keys: [...keys, key] }))) throw conflict();
    }
  }

  /** Deletion is idempotent for these permanently retired slots. A lost delete
   * acknowledgement retains its tombstone and can never restore callability. */
  async reconcile(deleteSecret: (account: string, custodyId: string | null) => void | boolean | Promise<void | boolean>, limit = 32): Promise<McpCredentialReconciliationResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new TypeError("Invalid MCP cleanup limit.");
    const result = { deleted: 0, blocked: 0, failed: 0, remaining: 0 };
    const keys = requireIndex((await this.ctx.systemSettings.get(INDEX))?.value).slice(0, limit);
    for (const key of keys) {
      try {
        const entry = await this.claim(key);
        if (!entry) { result.blocked += 1; continue; }
        if (entry.status !== "deleted" && await deleteSecret(entry.credentialRef.slice(SECRET_PREFIX.length), entry.custodyId) === false) {
          result.blocked += 1; continue;
        }
        await this.complete(key);
        result.deleted += 1;
      } catch {
        // A secret-store error may contain private data. Keep the exact pending
        // record and report only a count; the next reconciliation may retry it.
        result.failed += 1;
      }
    }
    result.remaining = requireIndex((await this.ctx.systemSettings.get(INDEX))?.value).length;
    return result;
  }

  private async claim(key: string): Promise<Retirement | undefined> {
    return this.ctx.runImmediateTransaction(async () => {
      const before = await this.ctx.systemSettings.get<Retirement>(key);
      if (!before) throw new Error("MCP retirement record is missing.");
      const entry = requireRetirement(key, before.value);
      // Unknown/foreign custodians are expected to remain pending. Rotate a
      // bounded pass so they cannot starve credentials owned by this host.
      const index = await this.ctx.systemSettings.get(INDEX);
      const keys = requireIndex(index?.value);
      if (keys.includes(key) && !(await this.ctx.systemSettings.compareAndSet(INDEX, index,
        { version: 1, keys: [...keys.filter((item) => item !== key), key] }))) throw conflict();
      // Inspect all canonical bindings, including a corrupt cross-server alias.
      // A tombstone cannot overrule evidence that a credential is still in use.
      if ((await readMcpBoundCredentialRefs(this.ctx)).has(entry.credentialRef)) return undefined;
      if (entry.status === "deleted") return entry;
      const claimed = { ...entry, status: "deleting" as const };
      if (!(await this.ctx.systemSettings.compareAndSet(key, before, claimed))) throw conflict();
      return claimed;
    });
  }

  private async complete(key: string): Promise<void> {
    await this.ctx.runImmediateTransaction(async () => {
      const before = await this.ctx.systemSettings.get<Retirement>(key);
      if (!before) throw new Error("MCP retirement record is missing.");
      const entry = requireRetirement(key, before.value);
      if (entry.status === "pending") throw conflict();
      if (!(await this.ctx.systemSettings.compareAndSet(key, before, { ...entry, status: "deleted" }))) throw conflict();
      const index = await this.ctx.systemSettings.get(INDEX);
      const keys = requireIndex(index?.value);
      if (!(await this.ctx.systemSettings.compareAndSet(INDEX, index, { version: 1, keys: keys.filter((item) => item !== key) })))
        throw conflict();
    });
  }
}

function unique(refs: readonly (string | undefined)[]): string[] {
  if (!Array.isArray(refs) || refs.length > 3 || refs.some((ref) => ref !== undefined && typeof ref !== "string"))
    throw new TypeError("Invalid MCP credential references.");
  return [...new Set(refs.filter((ref): ref is string => ref !== undefined))];
}
function assertOwned(serverId: string, ref: string): void {
  if (!isOwned(serverId, ref))
    throw new ConflictError({ message: "MCP credential retirement requires its exact server-owned reference." });
}
export function isMcpCredentialRefOwned(serverId: string, ref: string): boolean {
  return typeof serverId === "string" && Boolean(serverId) && serverId.length <= 160 && typeof ref === "string" && ref.length <= 512 &&
    (isMcpOAuthTokenRefForServer(ref, serverId, "access-token") || isMcpOAuthTokenRefForServer(ref, serverId, "refresh-token") ||
      isMcpEnvironmentRefForServer(ref, serverId));
}
const isOwned = isMcpCredentialRefOwned;
export async function readMcpBoundCredentialRefs(ctx: McpCredentialMetadataContext): Promise<Set<unknown>> {
  const auth = requireRows((await ctx.systemSettings.get("mcp_auth_state_v1"))?.value);
  const environment = requireRows((await ctx.systemSettings.get("mcp_environment_bindings_v1"))?.value);
  return new Set([...auth, ...environment].flatMap((row) => [row.accessTokenRef, row.refreshTokenRef, row.credentialRef]));
}
function keyFor(ref: string): string { return PREFIX + createHash("sha256").update(ref, "utf8").digest("hex"); }
function requireIndex(value: unknown): string[] {
  if (value === undefined) return [];
  const row = value as { version?: unknown; keys?: unknown };
  if (!row || typeof row !== "object" || Object.keys(row).length !== 2 || row.version !== 1 || !Array.isArray(row.keys) ||
    row.keys.length > MAX_PENDING || row.keys.some((key) => typeof key !== "string" || !KEY.test(key)) ||
    new Set(row.keys).size !== row.keys.length) throw new Error("Invalid MCP retirement index.");
  return [...row.keys] as string[];
}
function requireRetirement(key: string, input: unknown): Retirement {
  const value = input as Retirement;
  const legacy = (input as { version?: number })?.version === 1;
  if (!value || typeof value !== "object" || Object.keys(value).length !== (legacy ? 5 : 6) || (!legacy && value.version !== 2) ||
    (!legacy && value.custodyId !== null && (typeof value.custodyId !== "string" || !/^[a-f0-9]{64}$/u.test(value.custodyId))) ||
    !["pending", "deleting", "deleted"].includes(value.status) || typeof value.retiredAt !== "string" ||
    !Number.isFinite(Date.parse(value.retiredAt))) throw new Error("Invalid MCP retirement record.");
  assertOwned(value.serverId, value.credentialRef);
  if (key !== keyFor(value.credentialRef)) throw new Error("MCP retirement identity mismatch.");
  return { ...value, version: 2, custodyId: legacy ? null : value.custodyId };
}
function requireRows(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP credential bindings are unavailable.");
  const rows = Object.values(value) as unknown[];
  if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Invalid MCP credential binding.");
  for (const row of rows as Record<string, unknown>[]) {
    if ([row.accessTokenRef, row.refreshTokenRef, row.credentialRef].some((ref) => ref !== undefined && typeof ref !== "string"))
      throw new Error("Invalid MCP credential reference.");
  }
  return rows as Record<string, unknown>[];
}
function conflict(): ConflictError {
  return new ConflictError({ code: "WRITE_CONFLICT", message: "MCP credential retirement changed; retry canonical reconciliation." });
}
