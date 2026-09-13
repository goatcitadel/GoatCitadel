import { createHash, randomUUID } from "node:crypto";
import { ConflictError } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import { CredentialWriteUncertainError } from "./secret-store-service.js";
import {
  isMcpCredentialRefOwned,
  readMcpBoundCredentialRefs,
  type McpCredentialMetadataContext,
  type McpCredentialRetirementStore,
} from "./mcp-credential-retirement-store.js";

const INDEX = "mcp_credential_staging_v1";
const PREFIX = "mcp_credential_staged_v1:";
const KEY = /^mcp_credential_staged_v1:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_PENDING = 4096;
const PUBLICATION_WINDOW_MS = 10 * 60_000;
type Stage = {
  version: 2;
  custodyId: string | null;
  serverId: string;
  credentialRef: string;
  writeId: string;
  createdAt: number;
  readyAt: number | null;
  status: "writing" | "ready" | "published" | "retired";
};

export interface McpCredentialStagingResult {
  retired: number;
  writing: number;
  pending: number;
  blocked: number;
  failed: number;
  remaining: number;
}

/** Only opaque references enter this private journal. The synchronous keychain
 * writer runs outside database transactions, after durable registration. A lost
 * writer acknowledgement stays quarantined; elapsed time cannot prove it ended. */
export class McpCredentialStagingStore {
  constructor(
    private readonly ctx: McpCredentialMetadataContext,
    private readonly retirements: McpCredentialRetirementStore,
    private readonly now: () => number = Date.now,
  ) {}

  async write(serverId: string, refs: readonly string[], write: () => undefined, custodyId: string | null = null): Promise<void> {
    const owned = requireRefs(serverId, refs);
    if (custodyId !== null && (typeof custodyId !== "string" || !/^[a-f0-9]{64}$/u.test(custodyId))) throw conflict("Invalid MCP credential custodian.");
    const writeId = randomUUID();
    await this.ctx.runImmediateTransaction(async () => {
      await this.retirements.assertPublishable(serverId, owned);
      const bound = await readMcpBoundCredentialRefs(this.ctx);
      const index = await this.ctx.systemSettings.get(INDEX);
      const keys = requireIndex(index?.value);
      if (keys.length + owned.length > MAX_PENDING) throw conflict("MCP credential staging backlog requires reconciliation.");
      for (const ref of owned) {
        const key = keyFor(ref);
        if (bound.has(ref) || await this.ctx.systemSettings.get(key)) throw conflict("MCP credential staging requires a fresh version.");
        const entry: Stage = { version: 2, custodyId, serverId, credentialRef: ref, writeId,
          createdAt: this.timestamp(), readyAt: null, status: "writing" };
        if (!(await this.ctx.systemSettings.compareAndSet(key, undefined, entry))) throw conflict();
        keys.push(key);
      }
      if (!(await this.ctx.systemSettings.compareAndSet(INDEX, index, { version: 1, keys }))) throw conflict();
    });
    let result: unknown;
    try { result = write(); }
    catch (error) {
      if (custodyId !== null || error instanceof CredentialWriteUncertainError) throw error;
      try { await this.finishWrite(serverId, owned, writeId, true); }
      catch { logger.warn("MCP failed credential write retained its staging record for reconciliation."); }
      throw error;
    }
    if (result !== undefined) {
      // Do not acknowledge an accidentally asynchronous writer as terminal.
      // Its reference remains unpublishable and cannot be automatically deleted.
      throw new TypeError("MCP credential staging requires a synchronous keychain writer.");
    }
    await this.finishWrite(serverId, owned, writeId, false);
  }

  async readCustody(serverId: string, ref: string): Promise<string | null> {
    const key = keyFor(ref);
    const stored = await this.ctx.systemSettings.get(key);
    if (!stored) return null;
    const entry = requireStage(key, stored.value);
    if (entry.serverId !== serverId) throw conflict();
    // Even corrupt canonical bindings cannot authorize retirement of a writer
    // that has no terminal acknowledgement.
    return entry.status === "writing" ? null : entry.custodyId;
  }

  /** Called in the same transaction as canonical auth/environment publication. */
  async publish(serverId: string, refs: readonly (string | undefined)[]): Promise<void> {
    for (const ref of new Set(refs)) {
      if (ref === undefined) continue;
      const key = keyFor(ref);
      const before = await this.ctx.systemSettings.get<Stage>(key);
      // Existing installations have credentials predating this journal.
      if (!before) continue;
      const entry = requireStage(key, before.value);
      if (entry.serverId !== serverId) throw conflict();
      if (entry.status === "published") continue;
      if (entry.status !== "ready" || this.timestamp() >= entry.readyAt! + PUBLICATION_WINDOW_MS)
        throw conflict("MCP credential write is unfinished or expired; reconnect with fresh credentials.");
      if (!(await this.ctx.systemSettings.compareAndSet(key, before, { ...entry, status: "published" }))) throw conflict();
      await this.removePending(key);
    }
  }

  async reconcile(limit = 32): Promise<McpCredentialStagingResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new TypeError("Invalid MCP staging cleanup limit.");
    const result: McpCredentialStagingResult = { retired: 0, writing: 0, pending: 0, blocked: 0, failed: 0, remaining: 0 };
    const keys = requireIndex((await this.ctx.systemSettings.get(INDEX))?.value).slice(0, limit);
    if (!keys.length) return result;
    for (const key of keys) {
      try {
        const state = await this.ctx.runImmediateTransaction(async () => {
          const before = await this.ctx.systemSettings.get<Stage>(key);
          if (!before) throw conflict();
          const entry = requireStage(key, before.value);
          if (entry.status === "writing") return "writing";
          if (entry.status !== "ready") throw conflict();
          if ((await readMcpBoundCredentialRefs(this.ctx)).has(entry.credentialRef)) return "blocked";
          if (this.timestamp() < entry.readyAt! + PUBLICATION_WINDOW_MS) return "pending";
          await this.retirements.record(entry.serverId, [entry.credentialRef], []);
          if (!(await this.ctx.systemSettings.compareAndSet(key, before, { ...entry, status: "retired" }))) throw conflict();
          await this.removePending(key);
          return "retired";
        });
        result[state] += 1;
      } catch { result.failed += 1; }
    }
    // Move inspected quarantines behind other pending rows so a bounded pass
    // cannot permanently starve later completed writes.
    await this.ctx.runImmediateTransaction(async () => {
      const index = await this.ctx.systemSettings.get(INDEX);
      const current = requireIndex(index?.value);
      const inspected = new Set(keys);
      const next = [...current.filter((key) => !inspected.has(key)), ...current.filter((key) => inspected.has(key))];
      if (!(await this.ctx.systemSettings.compareAndSet(INDEX, index, { version: 1, keys: next }))) throw conflict();
      result.remaining = next.length;
    });
    return result;
  }

  private async finishWrite(serverId: string, refs: readonly string[], writeId: string, failed: boolean): Promise<void> {
    await this.ctx.runImmediateTransaction(async () => {
      for (const ref of refs) {
        const key = keyFor(ref);
        const before = await this.ctx.systemSettings.get<Stage>(key);
        if (!before) throw conflict();
        const entry = requireStage(key, before.value);
        if (entry.writeId !== writeId || entry.serverId !== serverId || entry.status !== "writing") throw conflict();
        const next = { ...entry, readyAt: this.timestamp(), status: failed ? "retired" as const : "ready" as const };
        if (!(await this.ctx.systemSettings.compareAndSet(key, before, next))) throw conflict();
        if (failed) {
          await this.retirements.record(serverId, [ref], []);
          await this.removePending(key);
        }
      }
    });
  }

  private async removePending(key: string): Promise<void> {
    const index = await this.ctx.systemSettings.get(INDEX);
    const keys = requireIndex(index?.value);
    if (!keys.includes(key)) throw conflict();
    if (!(await this.ctx.systemSettings.compareAndSet(INDEX, index, { version: 1, keys: keys.filter((value) => value !== key) }))) throw conflict();
  }

  private timestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - PUBLICATION_WINDOW_MS)
      throw new TypeError("MCP credential staging clock is unavailable.");
    return now;
  }
}

function requireRefs(serverId: string, refs: readonly string[]): string[] {
  if (!Array.isArray(refs) || !refs.length || refs.length > 2 || new Set(refs).size !== refs.length ||
    refs.some((ref) => !isMcpCredentialRefOwned(serverId, ref) || !UUID.test(ref.slice(ref.lastIndexOf(":") + 1))))
    throw conflict("MCP credential staging requires fresh server-owned references.");
  return [...refs];
}
function keyFor(ref: string): string { return PREFIX + createHash("sha256").update(ref, "utf8").digest("hex"); }
function requireIndex(value: unknown): string[] {
  if (value === undefined) return [];
  const row = value as { version?: unknown; keys?: unknown };
  if (!row || typeof row !== "object" || Object.keys(row).length !== 2 || row.version !== 1 || !Array.isArray(row.keys) ||
    row.keys.length > MAX_PENDING || row.keys.some((key) => typeof key !== "string" || !KEY.test(key)) ||
    new Set(row.keys).size !== row.keys.length) throw new Error("Invalid MCP credential staging index.");
  return [...row.keys] as string[];
}
function requireStage(key: string, value: unknown): Stage {
  const row = value as Stage & { version: number };
  const legacy = (value as { version?: number })?.version === 1;
  if (!row || typeof row !== "object" || Object.keys(row).length !== (legacy ? 7 : 8) || (!legacy && row.version !== 2) || !UUID.test(row.writeId) ||
    (!legacy && row.custodyId !== null && (typeof row.custodyId !== "string" || !/^[a-f0-9]{64}$/u.test(row.custodyId))) ||
    !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 ||
    !["writing", "ready", "published", "retired"].includes(row.status) ||
    (row.status === "writing" ? row.readyAt !== null : !Number.isSafeInteger(row.readyAt) || row.readyAt! < row.createdAt))
    throw new Error("Invalid MCP credential staging record.");
  requireRefs(row.serverId, [row.credentialRef]);
  if (keyFor(row.credentialRef) !== key) throw new Error("MCP credential staging identity mismatch.");
  return { ...row, version: 2, custodyId: legacy ? null : row.custodyId };
}
function conflict(message = "MCP credential staging changed; retry canonical reconciliation."): ConflictError {
  return new ConflictError({ message });
}
