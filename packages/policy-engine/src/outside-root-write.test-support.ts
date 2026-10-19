import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { ToolGrantCreateInput, ToolGrantRecord, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

/** Filesystem layout for outside-root write tests: a runtime with a jail, and a folder outside it. */
export interface OutsideRootFixture {
  base: string;
  runtimeRoot: string;
  jailRoot: string;
  secretsDir: string;
  outside: string;
  cleanup(): void;
}

export function createOutsideRootFixture(): OutsideRootFixture {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "goat-outside-root-engine-")));
  const runtimeRoot = path.join(base, "runtime");
  const jailRoot = path.join(runtimeRoot, "data");
  const secretsDir = path.join(jailRoot, "secrets");
  const outside = path.join(base, "scratch", "reports");
  for (const dir of [secretsDir, outside]) fs.mkdirSync(dir, { recursive: true });
  return {
    base,
    runtimeRoot,
    jailRoot,
    secretsDir,
    outside,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

export function outsideRootConfig(
  fixture: OutsideRootFixture,
  overrides: { mode?: "deny" | "approval_required"; deny?: string[]; approvalMode?: "approve_all" | "approve_risky" | "bypass" } = {},
): ToolPolicyConfig {
  return {
    tools: { approvalMode: overrides.approvalMode ?? "approve_risky", allow: ["*"], deny: overrides.deny ?? [] },
    agents: {},
    sandbox: {
      writeJailRoots: [fixture.jailRoot],
      readOnlyRoots: [],
      readAccessMode: "roots_only",
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
      outsideRootWriteMode: overrides.mode ?? "approval_required",
      runtimeWriteProtection: { rootDir: fixture.runtimeRoot, protectedPaths: [fixture.secretsDir] },
    },
  };
}

interface StoredApproval {
  approvalId: string;
  status: string;
  preview?: Record<string, unknown>;
  payload?: unknown;
  expiresAt?: string;
}

interface StoredEvent {
  approvalId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

interface StoredPending {
  approvalId: string;
  actionType: string;
  request: Record<string, unknown>;
  resolutionStatus: string;
}

/** In-memory storage covering the engine's approval, event, pending-action, and grant paths. */
export function createOutsideRootStorage() {
  const approvals = new Map<string, StoredApproval>();
  const events: StoredEvent[] = [];
  const pending = new Map<string, StoredPending>();
  const grants: ToolGrantRecord[] = [];
  let approvalSeq = 0;
  let grantSeq = 0;
  const createApproval = (input: { preview?: Record<string, unknown>; payload?: unknown }, ttlMs = 15 * 60_000) => {
    approvalSeq += 1;
    const record: StoredApproval = {
      approvalId: `approval-${approvalSeq}`,
      status: "pending",
      preview: input.preview,
      payload: input.payload,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    approvals.set(record.approvalId, record);
    return { ...record, createdAt: new Date().toISOString(), explanationStatus: "not_requested" };
  };
  const createGrant = (input: ToolGrantCreateInput, expiresAt?: string): ToolGrantRecord => {
    grantSeq += 1;
    const grant: ToolGrantRecord = {
      grantId: `grant-${grantSeq}`,
      toolPattern: input.toolPattern,
      decision: input.decision,
      scope: input.scope,
      scopeRef: input.scopeRef ?? "",
      grantType: input.grantType ?? "persistent",
      constraints: input.constraints,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt ?? input.expiresAt,
    };
    grants.push(grant);
    return grant;
  };
  const isActive = (grant: ToolGrantRecord) =>
    !grant.revokedAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now());
  const storage = {
    runImmediateTransaction: vi.fn(async <T>(work: () => T | Promise<T>) => await work()),
    approvals: {
      create: vi.fn(async (input: { preview?: Record<string, unknown> }) => createApproval(input)),
      createWithTtlDuration: vi.fn(async (input: { preview?: Record<string, unknown> }, ttlMs: number) =>
        createApproval(input, ttlMs),
      ),
      get: vi.fn(async (approvalId: string) => {
        const record = approvals.get(approvalId);
        if (!record) throw new Error(`approval ${approvalId} not found`);
        return record;
      }),
    },
    approvalEvents: {
      append: vi.fn(async (event: StoredEvent) => {
        events.push(event);
      }),
      listByApprovalId: vi.fn(async (approvalId: string) => events.filter((event) => event.approvalId === approvalId)),
    },
    audit: { append: vi.fn(async () => undefined) },
    db: { prepare: vi.fn(() => ({ run: vi.fn(async () => undefined) })) },
    pendingApprovalActions: {
      upsertPending: vi.fn(async (input: { approvalId: string; actionType: string; request: Record<string, unknown> }) => {
        pending.set(input.approvalId, { ...input, resolutionStatus: "pending" });
      }),
      find: vi.fn(async (approvalId: string) => pending.get(approvalId)),
      findFreshPending: vi.fn(async (approvalId: string) => pending.get(approvalId)),
      markResolved: vi.fn(async () => undefined),
    },
    toolAccessDecisions: {
      record: vi.fn(async () => undefined),
      countToolCallsInLastHourInScope: vi.fn(async () => 1),
      countWritesInLastHourInScope: vi.fn(async () => 0),
    },
    toolGrants: {
      list: vi.fn(async () => grants),
      listActive: vi.fn(async (scope: string, scopeRef?: string) =>
        grants.filter((grant) => isActive(grant) && grant.scope === scope && grant.scopeRef === (scopeRef ?? "")),
      ),
      findActive: vi.fn(async (grantId: string) => grants.find((grant) => grant.grantId === grantId && isActive(grant))),
      consumeOne: vi.fn(async () => true),
      create: vi.fn(async (input: ToolGrantCreateInput) => createGrant(input)),
      createTtlForDuration: vi.fn(async (input: ToolGrantCreateInput, ttlMs: number) =>
        createGrant({ ...input, grantType: "ttl" }, new Date(Date.now() + ttlMs).toISOString()),
      ),
      revoke: vi.fn(async (grantId: string) => {
        const grant = grants.find((entry) => entry.grantId === grantId);
        if (grant) grant.revokedAt = new Date().toISOString();
        return Boolean(grant);
      }),
    },
  };
  return {
    storage: storage as unknown as AsyncStorage,
    approvals,
    events,
    pending,
    grants,
    approve(approvalId: string) {
      const record = approvals.get(approvalId);
      if (record) record.status = "approved";
    },
    seedApproval(input: { approvalId: string; request: Record<string, unknown>; registration?: Record<string, unknown> }) {
      approvals.set(input.approvalId, { approvalId: input.approvalId, status: "approved" });
      pending.set(input.approvalId, {
        approvalId: input.approvalId,
        actionType: "tool.invoke",
        request: input.request,
        resolutionStatus: "pending",
      });
      events.push({ approvalId: input.approvalId, eventType: "pending_action_registered", payload: input.registration ?? {} });
    },
  };
}
