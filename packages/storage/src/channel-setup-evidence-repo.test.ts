import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CHANNEL_INGRESS_ACCEPTED_REVISION_KEY, ConflictError, type ChannelSetupEvidenceCreateInput } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { ChannelSetupEvidenceRepository } from "./channel-setup-evidence-repo.js";
import { InboundChannelEventRepository } from "./inbound-channel-event-repo.js";
import { ChannelSetupDraftRepository } from "./channel-setup-draft-repo.js";
import { IntegrationConnectionRepository } from "./integration-connection-repo.js";

const sample = (): ChannelSetupEvidenceCreateInput => ({
  catalogId: "channel.telegram", draftId: "draft-1", draftRevision: 2,
  connectionId: "connection-1", connectionRevision: "revision-1", phase: "test",
  status: "warn", checkedAt: "2026-10-09T02:30:00.000Z", issues: [{
    key: "cleanup", level: "warn", disposition: "advisory", message: "Remove the test message manually.",
  }], probe: { kind: "telegram", checkedAt: "2026-10-09T02:30:00.000Z", steps: [{
    key: "send", label: "Send", status: "pass", message: "Accepted", providerMessageId: "42",
  }] },
});

describe("Channel setup evidence", () => {
  it("retains redacted immutable receipts across restart and never persists arbitrary bodies", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-channel-evidence-"));
    const dbPath = path.join(directory, "test.db");
    let db = createDatabase({ dbPath });
    try {
      const repo = new ChannelSetupEvidenceRepository(db);
      const created = repo.create({ ...sample(), issues: [{ key: "redact", level: "error",
        message: "Authorization: Bearer synthetic-secret-value-for-channel-test",
        detail: "keychain:goatcitadel:channel-draft:private-reference callback=https://tenant.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/test/triggers/manual/paths/invoke?sig=synthetic-private-signature",
      }], ...({ payload: { body: "never persist this incoming message" } } as object) });
      const raw = String((db.prepare("SELECT payload_json FROM channel_setup_evidence WHERE evidence_id = ?").get(created.evidenceId) as { payload_json: string }).payload_json);
      assert.ok(!raw.includes("synthetic-secret-value-for-channel-test"));
      assert.ok(!raw.includes("private-reference"));
      assert.ok(!raw.includes("synthetic-private-signature"));
      assert.ok(!raw.includes("tenant.environment.api.powerplatform.com"));
      assert.ok(!raw.includes("never persist"));
      assert.throws(() => db.prepare("UPDATE channel_setup_evidence SET status='ok' WHERE evidence_id=?").run(created.evidenceId), /immutable/);
      assert.throws(() => db.prepare("DELETE FROM channel_setup_evidence WHERE evidence_id=?").run(created.evidenceId), /immutable/);
      db.close();
      db = createDatabase({ dbPath });
      const restarted = new ChannelSetupEvidenceRepository(db);
      assert.equal(restarted.get(created.evidenceId)?.draftRevision, 2);
      assert.equal(restarted.list({ connectionId: "connection-1" }).length, 1);
      assert.equal(restarted.list({ draftId: "different" }).length, 0);
      assert.throws(() => restarted.list({}), /Select a draft or connection/);
      assert.throws(() => restarted.list({ draftId: "draft-1", limit: 101 }), /between 1 and 100/);
    } finally {
      db.close();
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
      fs.rmdirSync(directory);
    }
  });
  it("binds acknowledgements to exact evidence owners and preserves warning severity", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const repo = new ChannelSetupEvidenceRepository(db);
      const tested = repo.create(sample());
      const ack = repo.create({ ...sample(), phase: "acknowledgement", priorEvidenceId: tested.evidenceId,
        acknowledgement: "cleanup", finalizationEligibility: { allowed: true, blockingReasons: [] } });
      assert.equal(ack.status, "warn");
      assert.equal(ack.issues[0]?.level, "warn");
      assert.throws(() => repo.create({ ...sample(), draftRevision: 3, priorEvidenceId: tested.evidenceId }), /exact draft revision/);
      assert.throws(() => repo.create({ ...sample(), draftId: "another", priorEvidenceId: tested.evidenceId }), /exact draft revision/);
    } finally { db.close(); }
  });
  it("uses durable append order when timestamps tie and rejects an acknowledgement of superseded proof", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const repo = new ChannelSetupEvidenceRepository(db);
      const fixed = "2026-10-09T02:30:00.000Z";
      const first = repo.create({ ...sample(), evidenceId: "z-earlier", createdAt: fixed, inputFingerprint: "same-input" });
      const latest = repo.create({ ...sample(), evidenceId: "a-later", createdAt: fixed, inputFingerprint: "same-input", status: "error" });
      assert.ok(latest.sequence! > first.sequence!);
      assert.equal(repo.list({ draftId: "draft-1" })[0]?.evidenceId, latest.evidenceId);
      assert.throws(() => repo.create({ ...sample(), inputFingerprint: "same-input", phase: "acknowledgement", priorEvidenceId: first.evidenceId, acknowledgement: "cleanup" }), /newer setup result/);
      assert.equal(repo.list({ draftId: "draft-1" }).length, 2);
    } finally { db.close(); }
  });
  it("deduplicates provider retries across rotations without changing their accepted generation", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const repo = new InboundChannelEventRepository(db);
      const event = { channelKey: "telegram", connectionId: "connection-1", transport: "telegram_webhook",
        dispatchKind: "agent_turn" as const, idempotencyKey: "update-42", laneKey: "chat-42" };
      const first = repo.accept({ ...event, payload: { text: "hello", [CHANNEL_INGRESS_ACCEPTED_REVISION_KEY]: "old" } });
      const repeated = repo.accept({ ...event, payload: { text: "hello", [CHANNEL_INGRESS_ACCEPTED_REVISION_KEY]: "new" } });
      assert.equal(repeated.outcome, "duplicate");
      assert.equal(repeated.event.eventId, first.event.eventId);
      assert.equal(repeated.event.payload[CHANNEL_INGRESS_ACCEPTED_REVISION_KEY], "old");
      assert.equal(repeated.event.payloadHash, first.event.payloadHash);
      assert.throws(() => repo.accept({ ...event, payload: { text: "changed", [CHANNEL_INGRESS_ACCEPTED_REVISION_KEY]: "new" } }), ConflictError);
      assert.equal(repo.listByConnection({ connectionId: "connection-1", channelKey: "telegram" }).length, 1);
      assert.equal(repo.listByConnection({ connectionId: "another" }).length, 0);
      assert.throws(() => repo.listByConnection({ connectionId: "connection-1", limit: 101 }), /1 through 100/);
    } finally { db.close(); }
  });
  it("atomically blocks acknowledgement and activation behind an unbound failure until a new test succeeds", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const repo = new ChannelSetupEvidenceRepository(db);
      const first = repo.create({ ...sample(), status: "ok", inputFingerprint: "same-input" });
      repo.create({ ...sample(), draftRevision: 3, status: "error" });
      for (const phase of ["acknowledgement", "activation"] as const) {
        assert.throws(() => repo.create({ ...first, evidenceId: undefined, phase,
          priorEvidenceId: first.evidenceId,
          ...(phase === "acknowledgement" ? { acknowledgement: "cleanup" as const } : {}),
        }), /newer setup result/);
      }
      assert.equal(repo.list({ draftId: "draft-1" }).length, 2);
      const retested = repo.create({ ...sample(), draftRevision: 3, status: "ok", inputFingerprint: "same-input" });
      const ack = repo.create({ ...retested, evidenceId: undefined, phase: "acknowledgement",
        priorEvidenceId: retested.evidenceId, acknowledgement: "cleanup" });
      assert.equal(ack.priorEvidenceId, retested.evidenceId);
    } finally { db.close(); }
  });
  it("commits activation evidence with the connection and rolls back a malformed receipt", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const drafts = new ChannelSetupDraftRepository(db);
      const evidence = new ChannelSetupEvidenceRepository(db);
      const connections = new IntegrationConnectionRepository(db);
      const draft = drafts.create({ catalogId: "channel.telegram", lifecycleMode: "create", enabled: true,
        draft: {}, contentVersion: "v1", adapterVersion: "v1", validationVersion: "v1", testVersion: "v1" });
      const input = { connectionId: randomUUID(), catalogId: "channel.telegram", kind: "channel" as const,
        key: "telegram", label: "Sandbox", enabled: true, status: "connected" as const, config: {},
        lastSyncAt: new Date().toISOString() };
      const tested = evidence.create({ ...sample(), draftId: draft.draftId, draftRevision: draft.revision });
      assert.throws(() => drafts.finalizeConnection(draft.draftId, draft.revision, { ...input,
        setupEvidence: { ...sample(), draftId: "wrong-owner", phase: "activation" } }), /belong to this channel/);
      assert.equal(drafts.get(draft.draftId).revision, draft.revision);
      assert.throws(() => connections.get(input.connectionId), /not found/);
      const connection = drafts.finalizeConnection(draft.draftId, draft.revision, { ...input,
        setupEvidence: { ...sample(), draftId: draft.draftId, draftRevision: draft.revision,
          phase: "activation", priorEvidenceId: tested.evidenceId, connectionRevision: "caller-stale" } });
      assert.throws(() => drafts.get(draft.draftId), /not found/);
      const receipt = evidence.list({ connectionId: connection.connectionId }).find((item) => item.phase === "activation");
      assert.equal(receipt?.connectionRevision, connection.revision);
      assert.equal(receipt?.activationDraftRevision, draft.revision);
      assert.equal(receipt?.priorEvidenceId, tested.evidenceId);
    } finally { db.close(); }
  });
  it("rolls back activation when newer proof superseded the reviewed test", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const drafts = new ChannelSetupDraftRepository(db);
      const evidence = new ChannelSetupEvidenceRepository(db);
      const connections = new IntegrationConnectionRepository(db);
      const draft = drafts.create({ catalogId: "channel.telegram", lifecycleMode: "create", enabled: true,
        draft: {}, contentVersion: "v1", adapterVersion: "v1", validationVersion: "v1", testVersion: "v1" });
      const tested = evidence.create({ ...sample(), draftId: draft.draftId, draftRevision: draft.revision,
        inputFingerprint: "reviewed-input" });
      evidence.create({ ...sample(), draftId: draft.draftId, draftRevision: draft.revision,
        status: "error" });
      const connectionId = randomUUID();
      assert.throws(() => drafts.finalizeConnection(draft.draftId, draft.revision, {
        connectionId, catalogId: "channel.telegram", kind: "channel", key: "telegram", label: "Sandbox",
        enabled: true, status: "connected", config: {}, lastSyncAt: new Date().toISOString(),
        setupEvidence: { ...tested, evidenceId: undefined, phase: "activation", priorEvidenceId: tested.evidenceId },
      }), /newer setup result/);
      assert.equal(drafts.get(draft.draftId).revision, draft.revision);
      assert.throws(() => connections.get(connectionId), /not found/);
      assert.equal(evidence.list({ draftId: draft.draftId }).length, 2);
    } finally { db.close(); }
  });
});
