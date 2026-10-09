import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, type ChannelSetupDraft } from "@goatcitadel/contracts";
import type { AsyncStorage, ChannelOAuthAttemptRecord } from "@goatcitadel/storage";
import { ChannelOAuthStagingService, type ChannelOAuthStagingPort } from "./channel-oauth-staging-service.js";

const config = { clientId: "client", clientSecret: "synthetic-client-secret", redirectUri: "https://app.example.test/callback", stateSecret: "synthetic-state-secret" };
const actor = { actorId: "operator-a", workspaceId: "workspace-a" };
const draftId = "11111111-1111-4111-8111-111111111111";
export function createOAuthFixture() {
  const attempts = new Map<string, ChannelOAuthAttemptRecord>();
  const drafts = new Map<string, ChannelSetupDraft>();
  const connections = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, string>();
  drafts.set(draftId, { draftId, revision: 1, catalogId: "channel.slack", lifecycleMode: "create", enabled: true,
    draft: { targets: [{ channel: "C-SANDBOX", default: true }] }, secretState: {}, contentVersion: "v1", adapterVersion: "v1",
    validationVersion: "v1", testVersion: "v1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const attemptRepo = {
    create: vi.fn(async (input) => {
      const value = { ...input, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      attempts.set(value.attemptId, value); return structuredClone(value);
    }),
    get: vi.fn(async (id: string) => { const value = attempts.get(id); if (!value) throw new NotFoundError("Attempt unavailable"); return structuredClone(value); }),
    findByStateHash: vi.fn(async (hash: string) => [...attempts.values()].find((value) => value.stateHash === hash)),
    update: vi.fn(async (id: string, patch) => {
      const current = attempts.get(id)!;
      if (current.revision !== patch.expectedRevision) throw new ConflictError({ code: "WRITE_CONFLICT", message: "Attempt changed" });
      const { expectedRevision: _, ...next } = patch;
      const updated = { ...current, ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      attempts.set(id, updated); return structuredClone(updated);
    }),
    listExpiring: vi.fn(async (now: string) => [...attempts.values()].filter((value) =>
      (value.expiresAt <= now && ["pending", "exchanging", "ready"].includes(value.status)) ||
      (["failed", "expired", "cancelled"].includes(value.status) && Object.keys(value.secretRefs).length))),
    listByDraft: vi.fn(async (id: string) => [...attempts.values()].filter((value) => value.draftId === id && value.status !== "adopted")),
    listInterruptedExchanges: vi.fn(async () => [...attempts.values()].filter((value) => value.status === "exchanging")),
  };
  const storage = {
    channelOAuthAttempts: attemptRepo,
    channelSetupDrafts: {
      get: vi.fn(async (id: string) => { const draft = drafts.get(id); if (!draft) throw new NotFoundError("Draft unavailable"); return structuredClone(draft); }),
      update: vi.fn(async (id: string, patch) => {
        const draft = drafts.get(id)!;
        if (draft.revision !== patch.expectedRevision) throw new ConflictError({ code: "WRITE_CONFLICT", message: "Draft changed" });
        const { expectedRevision: _, ...next } = patch;
        const updated = { ...draft, ...next, revision: draft.revision + 1 }; drafts.set(id, updated); return structuredClone(updated);
      }),
    },
    integrationConnections: {
      get: vi.fn(async (id: string) => { const connection = connections.get(id); if (!connection) throw new NotFoundError("Connection unavailable"); return structuredClone(connection); }),
      create: vi.fn(), update: vi.fn(),
    },
    workspaces: { get: vi.fn(async (id: string) => ({ workspaceId: id, lifecycleStatus: "active" })) },
    runImmediateTransaction: vi.fn(async (fn: () => Promise<unknown>) => {
      const oldAttempts = structuredClone(attempts), oldDrafts = structuredClone(drafts);
      try { return await fn(); } catch (error) {
        attempts.clear(); drafts.clear(); for (const entry of oldAttempts) attempts.set(...entry); for (const entry of oldDrafts) drafts.set(...entry);
        throw error;
      }
    }),
  } as unknown as ChannelOAuthStagingPort["storage"];
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    ok: true, access_token: "xoxb-synthetic-fixture", team: { id: "T123", name: "Workspace" },
    app_id: "A123", bot_user_id: "U123", scope: "chat:write,channels:read",
  }), { status: 200 }));
  const channelSecrets = {
    storeTemporary: vi.fn((id: string, field: string, value: string) => {
      const ref = `keychain:goatcitadel:channel-draft:${id}:${field}:${secrets.size}`; secrets.set(ref, value); return ref;
    }),
    resolve: vi.fn((ref: string) => { const value = secrets.get(ref); if (!value) throw new Error("Unavailable keychain value"); return value; }),
    deleteTemporary: vi.fn((ref: string) => secrets.delete(ref)),
    assertUsableForDraft: vi.fn((ref: string, binding: { draftId: string; fieldKey: string }) => {
      if (!ref.includes(`channel-draft:${binding.draftId}:${binding.fieldKey}:`)) throw new Error("Wrong secret owner");
    }),
  };
  const port: ChannelOAuthStagingPort = { installationId: "installation-a", storage, channelSecrets, recentChannelSetupTests: new Map(), fetcher };
  return { attempts, drafts, connections, secrets, attemptRepo, storage: storage as AsyncStorage, fetcher, port, service: new ChannelOAuthStagingService(port) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("staged Slack OAuth owner", () => {
  it("stages a scoped receipt and atomically adopts only into the draft, never the active connection", async () => {
    const f = createOAuthFixture();
    const activeId = "connection-existing";
    f.connections.set(activeId, { connectionId: activeId, catalogId: "channel.slack", revision: "a".repeat(64),
      enabled: true, status: "connected", config: { authMode: "oauth", slackTeamId: "T123", slackAppId: "A123", botToken: "keychain:existing" } });
    Object.assign(f.drafts.get(draftId)!, { connectionId: activeId, connectionRevision: "a".repeat(64), lifecycleMode: "rotate_secret" });
    const original = structuredClone(f.connections.get(activeId));
    const start = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    const result = await f.service.callback(start.state!, config, "one-code");
    expect(result).toMatchObject({ attemptId: start.attempt!.attemptId, draftId, draftRevision: 1, status: "ready", install: { installId: "slack:T123:A123" } });
    expect(JSON.stringify(result)).not.toContain("xoxb-");
    expect(JSON.stringify(result)).not.toContain("secretRef");
    expect(f.drafts.get(draftId)!.revision).toBe(1);
    const committed = vi.fn(async () => {});
    const adopted = await f.service.adopt(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1, attemptId: result.attemptId }, committed);
    expect(committed).toHaveBeenCalledOnce();
    expect(adopted.attempt.status).toBe("adopted");
    expect(adopted.draft.revision).toBe(2);
    expect(adopted.draft.draft.targets).toEqual([{ channel: "C-SANDBOX", default: true }]);
    expect(adopted.draft.secretState.botToken).toEqual({ configured: true, custody: "temporary", source: "operator" });
    expect(JSON.stringify(adopted)).not.toContain("keychain:");
    expect(f.attempts.get(result.attemptId)!.secretRefs).toEqual({});
    expect(f.connections.get(activeId)).toEqual(original);
    expect(f.storage.integrationConnections.create).not.toHaveBeenCalled();
    expect(f.storage.integrationConnections.update).not.toHaveBeenCalled();
    await expect(f.service.callback(start.state!, config, "replayed-code")).rejects.toThrow("already consumed");
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("isolates competing workspace/operator attempts and permits explicit adoption of only the initiated receipt", async () => {
    const f = createOAuthFixture();
    const otherDraft = "22222222-2222-4222-8222-222222222222";
    f.drafts.set(otherDraft, { ...structuredClone(f.drafts.get(draftId)!), draftId: otherDraft });
    const otherActor = { actorId: "operator-b", workspaceId: "workspace-b" };
    const a = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    const b = await f.service.start(otherActor, { workspaceId: otherActor.workspaceId, draftId: otherDraft, expectedRevision: 1 }, config);
    const br = await f.service.callback(b.state!, config, "code-b");
    await expect(f.service.status(actor, { workspaceId: actor.workspaceId, attemptId: br.attemptId })).rejects.toThrow("not found");
    await expect(f.service.adopt(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1, attemptId: br.attemptId })).rejects.toThrow("not found");
    expect((await f.service.status(actor, { workspaceId: actor.workspaceId, attemptId: a.attempt!.attemptId })).status).toBe("pending");
    expect(f.drafts.get(draftId)!.secretState).toEqual({});
    const ar = await f.service.callback(a.state!, config, "code-a");
    await f.service.adopt(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1, attemptId: ar.attemptId });
    expect(f.attempts.get(br.attemptId)!.status).toBe("ready");
  });
  it("fails callback/adoption on stale drafts and saved connection revisions without replacing credentials", async () => {
    const f = createOAuthFixture();
    const start = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    f.drafts.get(draftId)!.revision = 2;
    const failed = await f.service.callback(start.state!, config, "code");
    expect(failed).toMatchObject({ status: "failed", failureCode: "binding_changed" });
    expect(f.secrets.size).toBe(0);
    const next = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 2 }, config);
    const ready = await f.service.callback(next.state!, config, "code-two");
    f.drafts.get(draftId)!.revision = 3;
    await expect(f.service.adopt(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 2, attemptId: ready.attemptId })).rejects.toThrow("changed");
    expect(f.attempts.get(ready.attemptId)!.status).toBe("ready");
  });
  it("rejects reauthorization into a different Slack app or workspace", async () => {
    const f = createOAuthFixture();
    f.connections.set("existing", { catalogId: "channel.slack", revision: "a".repeat(64), config: { slackTeamId: "T123", slackAppId: "A-other" } });
    Object.assign(f.drafts.get(draftId)!, { connectionId: "existing", connectionRevision: "a".repeat(64) });
    const start = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    expect(await f.service.callback(start.state!, config, "code")).toMatchObject({ status: "failed", failureCode: "binding_changed" });
    expect(f.secrets.size).toBe(0);
  });
  it("cleans staged credentials after cancellation, expiry, and draft discard", async () => {
    const f = createOAuthFixture();
    const start = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    const ready = await f.service.callback(start.state!, config, "code");
    await f.service.cancel(actor, { workspaceId: actor.workspaceId, attemptId: ready.attemptId, expectedRevision: ready.revision });
    expect(f.secrets.size).toBe(0);
    const second = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    await f.service.callback(second.state!, config, "two");
    f.attempts.get(second.attempt!.attemptId)!.expiresAt = new Date(Date.now() - 1).toISOString();
    await f.service.cleanupExpired();
    expect(f.secrets.size).toBe(0);
    const third = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    await f.service.callback(third.state!, config, "three");
    f.drafts.delete(draftId);
    await f.service.cancelForDraft(draftId);
    expect(f.secrets.size).toBe(0);
    expect(f.attempts.get(third.attempt!.attemptId)!.status).toBe("cancelled");
  });
  it("records denied/incomplete/ambiguous outcomes and never replays a committed exchange after restart", async () => {
    const f = createOAuthFixture();
    const denied = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    expect(await f.service.callback(denied.state!, config, undefined, true)).toMatchObject({ status: "failed", failureCode: "operator_denied" });
    const incomplete = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, access_token: "xoxb-synthetic-fixture", team: { id: "T123" } })));
    expect(await f.service.callback(incomplete.state!, config, "code")).toMatchObject({ status: "failed", failureCode: "invalid_install" });
    const interrupted = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    f.attempts.get(interrupted.attempt!.attemptId)!.status = "exchanging";
    const restarted = new ChannelOAuthStagingService(f.port);
    await restarted.recoverInterrupted();
    expect((await restarted.status(actor, { workspaceId: actor.workspaceId, attemptId: interrupted.attempt!.attemptId })).failureCode).toBe("unknown_exchange_outcome");
    await expect(restarted.callback(interrupted.state!, config, "code")).rejects.toThrow("already consumed");
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("distinguishes definite Slack rejection from an interrupted exchange without exposing upstream errors", async () => {
    const f = createOAuthFixture();
    const rejected = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "invalid_code xoxb-synthetic-upstream-echo" }), { status: 200 }));
    const receipt = await f.service.callback(rejected.state!, config, "rejected");
    expect(receipt).toMatchObject({ status: "failed", failureCode: "exchange_failed" });
    expect(JSON.stringify(receipt)).not.toContain("upstream-echo");
    const interrupted = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    f.fetcher.mockRejectedValueOnce(new Error("Synthetic interrupted exchange"));
    expect(await f.service.callback(interrupted.state!, config, "interrupted")).toMatchObject({ status: "failed", failureCode: "unknown_exchange_outcome" });
    await expect(f.service.callback(interrupted.state!, config, "same-code")).rejects.toThrow("already consumed");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("rolls back draft adoption if consuming the ready receipt fails", async () => {
    const f = createOAuthFixture();
    const start = await f.service.start(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1 }, config);
    const ready = await f.service.callback(start.state!, config, "code");
    f.attemptRepo.update.mockRejectedValueOnce(new ConflictError({ code: "WRITE_CONFLICT", message: "Receipt changed" }));
    await expect(f.service.adopt(actor, { workspaceId: actor.workspaceId, draftId, expectedRevision: 1, attemptId: ready.attemptId })).rejects.toThrow("Receipt changed");
    expect(f.drafts.get(draftId)!.revision).toBe(1);
    expect(f.drafts.get(draftId)!.secretState).toEqual({});
    expect(f.attempts.get(ready.attemptId)!.status).toBe("ready");
  });
});