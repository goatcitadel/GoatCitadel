import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft, ChannelSetupEvidence, ChannelSetupEvidenceCreateInput, IntegrationConnection } from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import { buildEphemeralChannelConnection, getReusableChannelSetupTestResult } from "./channel-setup-helpers.js";
import { buildChannelSetupRecentTestSignature } from "./channel-setup-test-cache.js";
import { acknowledgeChannelSetupTest, buildCurrentChannelSetupEvidenceSignature, getChannelSetupDraftEvidence, restoreChannelSetupTestEvidence } from "./channel-setup-evidence-service.js";
import { finalizeChannelSetupDraft, testChannelSetupDraft, updateChannelSetupDraft, type ChannelSetupHost } from "./channel-setup-service.js";

function fixture(edit = false) {
  const definition = requireChannelSetupDefinition("channel.telegram").definition;
  const now = new Date().toISOString();
  const draft: ChannelSetupDraft = { draftId: randomUUID(), revision: 3, catalogId: "channel.telegram", lifecycleMode: edit ? "edit" : "create", enabled: true, draft: { botTokenEnv: "TELEGRAM_BOT_TOKEN", defaultChatId: "123", inboundAccessMode: "allowlist", allowedSenders: ["456"] }, secretState: {}, contentVersion: definition.wizard.contentVersion, adapterVersion: definition.adapter.adapterVersion, validationVersion: definition.validation.validationVersion, testVersion: definition.testing.testVersion, createdAt: now, updatedAt: now };
  const connection: IntegrationConnection = { connectionId: randomUUID(), revision: "a".repeat(64), catalogId: draft.catalogId, kind: "channel", key: "telegram", label: "Telegram", enabled: true, status: "connected", config: { ...draft.draft }, createdAt: now, updatedAt: now };
  if (edit) { draft.connectionId = connection.connectionId; draft.connectionRevision = connection.revision; draft.label = connection.label; }
  const records: ChannelSetupEvidence[] = [];
  const get = vi.fn(async () => draft);
  const update = vi.fn(async (_id: string, input: Partial<ChannelSetupDraft> & { expectedRevision: number }) => {
    if (draft.revision !== input.expectedRevision) throw new Error("stale draft");
    Object.assign(draft, input, { revision: draft.revision + 1 }); return draft;
  });
  const create = vi.fn(async (input: ChannelSetupEvidenceCreateInput) => {
    const evidence = { ...input, evidenceId: input.evidenceId ?? randomUUID(), createdAt: input.createdAt ?? new Date().toISOString(), sequence: records.length + 1 };
    records.unshift(evidence); return evidence;
  });
  const list = vi.fn(async (_query: { draftId?: string; limit?: number }) => records);
  const host = { recentChannelSetupTests: new Map(), storage: { channelSetupDrafts: { get, update }, channelSetupEvidence: { create, get: vi.fn(async (id: string) => records.find((item) => item.evidenceId === id)), list } }, getIntegrationConnection: vi.fn(async () => connection), recordDevDiagnostic: vi.fn(), buildIntegrationConnectionChecks: vi.fn(() => []), runIntegrationConnectionLiveChecks: vi.fn(async () => ({ checks: [], probe: { kind: "telegram", checkedAt: now, steps: [{ key: "telegram_sandbox_send", label: "Send", status: "pass" as const, message: "Accepted", providerMessageId: "123" }] } })) } as unknown as ChannelSetupHost;
  const addProof = async (overrides: Partial<ChannelSetupEvidenceCreateInput> = {}) => {
    const ephemeral = await buildEphemeralChannelConnection(host, draft);
    return create({ catalogId: draft.catalogId, draftId: draft.draftId, draftRevision: draft.revision, connectionId: draft.connectionId, connectionRevision: draft.connectionRevision, phase: "test", status: "ok", checkedAt: new Date().toISOString(), issues: [], inputFingerprint: buildCurrentChannelSetupEvidenceSignature(draft, ephemeral), ...overrides });
  };
  return { draft, connection, records, host, get, update, create, list, addProof };
}

describe("read-only exact draft evidence", () => {
  it("restores canonical eligibility after cache loss without sending, writing or mutating history", async () => {
    const f = fixture();
    const evidence = await f.addProof({ issues: [{ key: "inbound_access_allowlist_empty", level: "warn", message: "Authorize a sender after activation." }], status: "warn", draftRevision: 2 });
    f.create.mockClear();
    const snapshot = structuredClone(f.records);
    const response = await getChannelSetupDraftEvidence(f.host, f.draft.draftId, 3);
    expect(response).toMatchObject({ draftId: f.draft.draftId, draftRevision: 3, items: [expect.objectContaining({ evidenceId: evidence.evidenceId, draftRevision: 2 })], currentTest: { evidenceId: evidence.evidenceId, draftRevision: 3, finalizationEligibility: { allowed: true, evidenceId: evidence.evidenceId } } });
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ draftId: f.draft.draftId, limit: 20 });
    expect(f.host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.host.recentChannelSetupTests.size).toBe(0);
    expect(f.records).toEqual(snapshot);
    response.items[0]!.issues[0]!.message = "UI-local change";
    expect(f.records).toEqual(snapshot);
  });

  it("returns history while keeping newer required failures blocking", async () => {
    const f = fixture(); await f.addProof();
    const failed = await f.addProof({ status: "error", issues: [{ key: "telegram_auth", level: "error", message: "Credential rejected." }] });
    const response = await getChannelSetupDraftEvidence(f.host, f.draft.draftId, 3);
    expect(response.items).toHaveLength(2);
    expect(response.currentTest).toMatchObject({ evidenceId: failed.evidenceId, status: "error", finalizationEligibility: { allowed: false } });
  });

  it.each([new Date(Date.now() - 360000).toISOString(), "not-a-time", "2099-01-01T00:00:00.000Z"])("never falls past latest matching proof with unusable checkedAt %s", async (checkedAt) => {
    const f = fixture(); await f.addProof(); await f.addProof({ checkedAt, status: "error", issues: [{ key: "required", level: "error", message: "Latest result." }] });
    expect((await getChannelSetupDraftEvidence(f.host, f.draft.draftId, 3)).currentTest).toBeUndefined();
    expect(await restoreChannelSetupTestEvidence(f.host, f.draft, await buildEphemeralChannelConnection(f.host, f.draft))).toBeUndefined();
  });

  it.each(["contentVersion", "validationVersion", "testVersion"] as const)("does not let an old %s proof certify the current runtime", async (versionKey) => {
    const f = fixture(); const connection = await buildEphemeralChannelConnection(f.host, f.draft);
    const oldDraft = { ...f.draft, [versionKey]: "old-runtime-v1" };
    await f.addProof({ inputFingerprint: buildChannelSetupRecentTestSignature(oldDraft, connection, oldDraft.testVersion) });
    const response = await getChannelSetupDraftEvidence(f.host, f.draft.draftId, 3);
    expect(response.items).toHaveLength(1);
    expect(response.currentTest).toBeUndefined();
  });

  it("reuses a new-runtime test on old persisted draft metadata consistently across evidence and cache", async () => {
    const f = fixture();
    f.draft.contentVersion = "old-content"; f.draft.validationVersion = "old-validation"; f.draft.testVersion = "old-test";
    const result = await testChannelSetupDraft(f.host, f.draft.draftId, 3);
    expect(result.finalizationEligibility?.allowed).toBe(true);
    expect(f.draft.contentVersion).toBe("old-content");
    expect(f.draft.validationVersion).toBe("old-validation");
    const cached = await getReusableChannelSetupTestResult(f.host, f.host.recentChannelSetupTests, f.draft);
    expect(cached?.evidenceId).toBe(result.evidenceId);
    f.host.recentChannelSetupTests.clear(); f.host.runIntegrationConnectionLiveChecks = vi.fn(); f.update.mockClear();
    const response = await getChannelSetupDraftEvidence(f.host, f.draft.draftId, result.draftRevision);
    expect(response.currentTest).toMatchObject({ evidenceId: result.evidenceId, finalizationEligibility: { allowed: true } });
    expect(f.host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });

  it("binds resolved Teams env credentials and keeps required validation failure ahead of an earlier pass", async () => {
    const f = fixture(); const definition = requireChannelSetupDefinition("channel.teams").definition;
    f.draft.catalogId = "channel.teams"; f.draft.draft = { webhookUrlEnv: "TEAMS_WORKFLOW_URL" };
    f.draft.contentVersion = definition.wizard.contentVersion; f.draft.validationVersion = definition.validation.validationVersion; f.draft.testVersion = definition.testing.testVersion;
    let endpoint = "https://defaultenvironment.00.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?sig=synthetic-env-proof";
    f.host.resolveConnectionSecret = vi.fn((config: Record<string, unknown>) => config.webhookUrlEnv === "TEAMS_WORKFLOW_URL" ? endpoint : undefined);
    f.host.runIntegrationConnectionLiveChecks = vi.fn(async () => ({ checks: [{ key: "teams_sandbox_send", status: "pass" as const, message: "Accepted." }], probe: { kind: "teams_webhook", mode: "webhook" as const, checkedAt: new Date().toISOString(), steps: [{ key: "teams_sandbox_send", label: "Send", status: "pass" as const, message: "Accepted." }] } }));
    f.host.commitChannelSetupConnection = vi.fn();
    const passed = await testChannelSetupDraft(f.host, f.draft.draftId, f.draft.revision);
    expect(passed.finalizationEligibility?.allowed).toBe(true);
    expect(await getReusableChannelSetupTestResult(f.host, f.host.recentChannelSetupTests, f.draft)).toMatchObject({ evidenceId: passed.evidenceId, proofExpiresAt: passed.proofExpiresAt });
    f.host.recentChannelSetupTests.clear();
    expect((await getChannelSetupDraftEvidence(f.host, f.draft.draftId, f.draft.revision)).currentTest?.evidenceId).toBe(passed.evidenceId);
    const previousFingerprint = f.records[0]!.inputFingerprint;
    endpoint = "https://outlook.office.com/webhook/synthetic-retired-env-proof";
    expect((await getChannelSetupDraftEvidence(f.host, f.draft.draftId, f.draft.revision)).currentTest).toBeUndefined();
    const failed = await testChannelSetupDraft(f.host, f.draft.draftId, f.draft.revision);
    expect(failed.status).toBe("error"); expect(f.records[0]!.inputFingerprint).toBeTruthy(); expect(f.records[0]!.inputFingerprint).not.toBe(previousFingerprint);
    const response = await getChannelSetupDraftEvidence(f.host, f.draft.draftId, f.draft.revision);
    expect(response.currentTest).toMatchObject({ evidenceId: failed.evidenceId, status: "error", finalizationEligibility: { allowed: false } });
    await expect(finalizeChannelSetupDraft(f.host, f.draft.draftId, f.draft.revision)).rejects.toThrow("validation errors");
    expect(f.host.runIntegrationConnectionLiveChecks).toHaveBeenCalledOnce(); expect(f.host.commitChannelSetupConnection).not.toHaveBeenCalled();
    expect(JSON.stringify({ response, records: f.records })).not.toContain("synthetic-env-proof");
    expect(JSON.stringify({ response, records: f.records })).not.toContain("synthetic-retired-env-proof");
  });

  it("keeps an unnormalizable failure as an exact-owner barrier until an explicit successful retest", async () => {
    const f = fixture(); f.host.commitChannelSetupConnection = vi.fn();
    const passed = await testChannelSetupDraft(f.host, f.draft.draftId, f.draft.revision);
    const goodInputs = structuredClone(f.draft.draft);
    await updateChannelSetupDraft(f.host, f.draft.draftId, { expectedRevision: f.draft.revision, draft: { ...goodInputs, allowedSenders: 123 } });
    const failed = await testChannelSetupDraft(f.host, f.draft.draftId, f.draft.revision);
    expect(failed.status).toBe("error"); expect(f.records[0]!.inputFingerprint).toBeUndefined();
    await updateChannelSetupDraft(f.host, f.draft.draftId, { expectedRevision: f.draft.revision, draft: goodInputs });
    const response = await getChannelSetupDraftEvidence(f.host, f.draft.draftId, f.draft.revision);
    expect(response.currentTest).toMatchObject({ evidenceId: failed.evidenceId, status: "error", finalizationEligibility: { allowed: false } });
    await expect(acknowledgeChannelSetupTest(f.host, f.draft.draftId, { expectedRevision: f.draft.revision, evidenceId: passed.evidenceId!, acknowledgement: "receipt" }, "operator")).rejects.toThrow("latest result");
    await expect(finalizeChannelSetupDraft(f.host, f.draft.draftId, f.draft.revision)).rejects.toThrow("Required setup checks failed");
    expect(f.host.runIntegrationConnectionLiveChecks).toHaveBeenCalledOnce(); expect(f.host.commitChannelSetupConnection).not.toHaveBeenCalled();
    const retested = await testChannelSetupDraft(f.host, f.draft.draftId, f.draft.revision);
    expect((await getChannelSetupDraftEvidence(f.host, f.draft.draftId, f.draft.revision)).currentTest).toMatchObject({ evidenceId: retested.evidenceId, finalizationEligibility: { allowed: true } });
    expect(f.host.runIntegrationConnectionLiveChecks).toHaveBeenCalledTimes(2);
  });

  it("retains the original proof deadline through acknowledgement, cache reuse and read-only restoration", async () => {
    const f = fixture();
    const tested = await testChannelSetupDraft(f.host, f.draft.draftId, f.draft.revision);
    const expiry = new Date(Date.parse(tested.checkedAt) + 300000).toISOString();
    expect(tested.proofExpiresAt).toBe(expiry);
    const acknowledged = await acknowledgeChannelSetupTest(f.host, f.draft.draftId, { expectedRevision: f.draft.revision, evidenceId: tested.evidenceId!, acknowledgement: "receipt" }, "operator");
    expect(acknowledged.checkedAt).toBe(tested.checkedAt); expect(acknowledged.proofExpiresAt).toBe(expiry);
    expect((await getReusableChannelSetupTestResult(f.host, f.host.recentChannelSetupTests, f.draft))?.proofExpiresAt).toBe(expiry);
    f.host.recentChannelSetupTests.clear();
    expect((await getChannelSetupDraftEvidence(f.host, f.draft.draftId, f.draft.revision)).currentTest?.proofExpiresAt).toBe(expiry);
  });

  it("rejects stale draft revision before evidence reads", async () => {
    const f = fixture(); await expect(getChannelSetupDraftEvidence(f.host, f.draft.draftId, 2)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(f.list).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });

  it("rejects a draft revision changed while history loads", async () => {
    const f = fixture(); await f.addProof(); f.list.mockImplementationOnce(async () => { f.draft.revision++; return f.records; });
    await expect(getChannelSetupDraftEvidence(f.host, f.draft.draftId, 3)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(f.update).not.toHaveBeenCalled(); expect(f.host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
  });

  it.each(["before", "during"] as const)("rejects the connection generation changed %s evidence read", async (timing) => {
    const f = fixture(true); await f.addProof();
    if (timing === "before") f.connection.revision = "b".repeat(64);
    else f.list.mockImplementationOnce(async () => { f.connection.revision = "b".repeat(64); return f.records; });
    await expect(getChannelSetupDraftEvidence(f.host, f.draft.draftId, 3)).rejects.toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "CHANNEL_CONNECTION_REVIEW_REQUIRED" } });
    expect(f.update).not.toHaveBeenCalled(); expect(f.host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
  });

  it("bounds and filters exact-owner history and sanitizes public strings", async () => {
    const f = fixture();
    for (let i = 0; i < 25; i++) await f.addProof({ issues: [{ key: "diagnostic", level: "warn", message: "Authorization: Bearer synthetic-private-evidence" }] });
    const foreign = { ...f.records[0]!, evidenceId: "foreign", draftId: randomUUID() };
    f.records.unshift(foreign);
    const response = await getChannelSetupDraftEvidence(f.host, f.draft.draftId, 3);
    expect(response.items).toHaveLength(20); expect(response.items.some((item) => item.evidenceId === "foreign")).toBe(false);
    expect(JSON.stringify(response)).not.toContain("synthetic-private-evidence");
  });

  it("reports unavailable evidence storage without manufacturing empty healthy history", async () => {
    const f = fixture(); delete f.host.storage.channelSetupEvidence;
    await expect(getChannelSetupDraftEvidence(f.host, f.draft.draftId, 3)).rejects.toMatchObject({ httpStatus: 503 });
  });
});
