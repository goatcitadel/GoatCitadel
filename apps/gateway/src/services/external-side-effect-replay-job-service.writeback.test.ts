import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExternalSideEffectReplayWorkflowPayload,
  ExternalSideEffectRunRecord,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { buildGatewayExternalSideEffectReplayJob } from "./external-side-effect-replay-job-service.js";
import { createExternalSideEffectReplayRecords } from "./external-side-effect-replay-record.js";
import { runReplaySafeExternalSideEffectWorker } from "./external-side-effect-runner-service.js";
import { invokeIntegrationConnectionAction, type IntegrationActionHost } from "./integration-action-service.js";
import { deriveLocalBridgeIdempotencyKey } from "./integration-writeback-run-inputs.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";

/**
 * End-to-end replay proofs for the WS8 allowlist: the LIVE invocation path produces the
 * run row and its sealed replay record against real SQLite storage, then the durable
 * replay worker reconciles or replays it through `buildGatewayExternalSideEffectReplayJob`.
 */

const REPLAY_KEY = Buffer.alloc(32, 7);
const CHECKED_AT = "2026-10-16T00:00:00.000Z";
const WORKSPACE_ID = "ws-replay";
const GMAIL_BASE_A = "https://gmail-a.example.test";
const GMAIL_BASE_B = "https://gmail-b.example.test";
const TRELLO_BASE = "https://trello.example.test";
const BRIDGE_URL = "http://127.0.0.1:4040";

const payload: ExternalSideEffectReplayWorkflowPayload = {
  version: "external_side_effect.replay.v1",
  workspaceId: WORKSPACE_ID,
  requestedBy: "operator",
  requestedAt: CHECKED_AT,
};

const cleanups: Array<() => Promise<void>> = [];
const savedEnv = {
  gmail: process.env.GOATCITADEL_GMAIL_API_BASE_URL,
  trello: process.env.GOATCITADEL_TRELLO_API_BASE_URL,
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  restoreEnv("GOATCITADEL_GMAIL_API_BASE_URL", savedEnv.gmail);
  restoreEnv("GOATCITADEL_TRELLO_API_BASE_URL", savedEnv.trello);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function timeoutError(): Error {
  return Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function connectionFor(catalogId: string, config: Record<string, unknown>): IntegrationConnection {
  const key = catalogId.split(".")[1]!;
  return {
    connectionId: `conn-${key}`,
    catalogId,
    kind: catalogId.split(".")[0] as IntegrationConnection["kind"],
    key,
    label: key,
    workspaceId: WORKSPACE_ID,
    enabled: true,
    status: "connected",
    config,
    createdAt: CHECKED_AT,
    updatedAt: CHECKED_AT,
  };
}

/** Wraps the real mutation store so the first dispatch marker fails before the boundary. */
function failFirstDispatch(store: MutationIdempotencyStore): MutationIdempotencyStore {
  let failed = false;
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "markDispatched" && !failed) {
        return async () => {
          failed = true;
          throw new Error("transient mutation ledger failure");
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function createHarness(
  connection: IntegrationConnection,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  options: { failFirstDispatch?: boolean } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-replay-writeback-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const asyncStorage = createSqliteAsyncStorage(storage);
  cleanups.push(async () => {
    await asyncStorage.close();
    rmSync(root, { recursive: true, force: true });
  });
  let liveConnection = connection;
  const fetchMock = vi.fn(fetchImpl);
  const mutationStore = asyncStorage.mutationIdempotency as unknown as MutationIdempotencyStore;
  const host: IntegrationActionHost = {
    storage: {
      integrationConnections: {
        get: async (connectionId: string) =>
          connectionId === liveConnection.connectionId ? liveConnection : undefined,
      },
      runImmediateTransaction: asyncStorage.runImmediateTransaction.bind(asyncStorage),
    },
    fetchWithDiagnosticsTimeout: fetchMock,
    readConnectionConfigValue: (config, key) => (typeof config[key] === "string" ? (config[key] as string) : undefined),
    resolveConnectionSecret: (config, directKey) =>
      typeof config[directKey] === "string" ? (config[directKey] as string) : undefined,
    publishRealtime: vi.fn(async () => undefined),
    mutationStore: options.failFirstDispatch ? failFirstDispatch(mutationStore) : mutationStore,
    sideEffectRunStore: asyncStorage.externalSideEffectRuns,
    replayRecords: createExternalSideEffectReplayRecords({
      resolveKey: () => REPLAY_KEY,
      runs: asyncStorage.externalSideEffectRuns,
    }),
  };
  const readRun = async (): Promise<ExternalSideEffectRunRecord> => {
    const runs = await asyncStorage.externalSideEffectRuns.listByConnection(connection.connectionId, {
      workspaceId: WORKSPACE_ID,
    });
    expect(runs).toHaveLength(1);
    return runs[0]!;
  };
  const replay = async (run: ExternalSideEffectRunRecord) =>
    await runReplaySafeExternalSideEffectWorker({
      runs: [run],
      checkedAt: CHECKED_AT,
      buildJob: (candidate) => buildGatewayExternalSideEffectReplayJob(host, candidate, payload),
    });
  return {
    host,
    storage,
    fetchMock,
    readRun,
    replay,
    setConnection: (next: IntegrationConnection) => {
      liveConnection = next;
    },
  };
}

function createFakeGmail(options: { timeoutFirstSend?: boolean } = {}) {
  const messages: Array<{ id: string; threadId: string; messageId: string }> = [];
  let sends = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    if (init?.method === "POST" && parsed.pathname === "/gmail/v1/users/me/messages/send") {
      sends += 1;
      const raw = Buffer.from(String((JSON.parse(String(init.body)) as { raw: string }).raw), "base64url").toString();
      const messageId = /^Message-ID: <([^>]+)>$/m.exec(raw)?.[1] ?? "";
      const message = { id: `msg-${sends}`, threadId: `thread-${sends}`, messageId };
      messages.push(message);
      if (options.timeoutFirstSend && sends === 1) {
        throw timeoutError();
      }
      return jsonResponse({ id: message.id, threadId: message.threadId });
    }
    if (init?.method === "GET" && parsed.pathname === "/gmail/v1/users/me/messages") {
      const wanted = (parsed.searchParams.get("q") ?? "").replace(/^rfc822msgid:/, "");
      const match = messages.filter((message) => message.messageId === wanted);
      return jsonResponse({ messages: match.map(({ id, threadId }) => ({ id, threadId })) });
    }
    return jsonResponse({ message: "unexpected" }, 404);
  };
  return { fetchImpl, messages, sendCount: () => sends };
}

const gmailConnection = () => connectionFor("automation.gmail", { accessToken: "gmail-test-token" });
const gmailRequest = {
  idempotencyKey: "idem-gmail-1",
  input: { to: "ops@example.test", subject: "Replay proof", bodyText: "Sent exactly once." },
};

async function gmailPreBoundaryHarness(fake = createFakeGmail()) {
  process.env.GOATCITADEL_GMAIL_API_BASE_URL = GMAIL_BASE_A;
  const harness = await createHarness(gmailConnection(), fake.fetchImpl, { failFirstDispatch: true });
  const live = await invokeIntegrationConnectionAction(harness.host, "conn-gmail", "write", gmailRequest);
  expect(live.status).toBe("failed");
  const run = await harness.readRun();
  expect(run.status).toBe("failed_before_boundary");
  expect(fake.sendCount()).toBe(0);
  return { harness, fake, run };
}

describe("buildGatewayExternalSideEffectReplayJob writeback replay (WS8)", () => {
  it("gmail: replay after a provider timeout produces exactly one email", async () => {
    process.env.GOATCITADEL_GMAIL_API_BASE_URL = GMAIL_BASE_A;
    const fake = createFakeGmail({ timeoutFirstSend: true });
    const harness = await createHarness(gmailConnection(), fake.fetchImpl);

    const live = await invokeIntegrationConnectionAction(harness.host, "conn-gmail", "write", gmailRequest);
    expect(live.status).toBe("failed");
    const run = await harness.readRun();
    expect(run.status).toBe("unknown_external_outcome");

    const results = await harness.replay(run);

    expect(results).toMatchObject([{ status: "reconciled", externalReferenceId: "messageId:msg-1" }]);
    expect(await harness.readRun()).toMatchObject({ status: "completed" });
    expect(fake.sendCount()).toBe(1);
    expect(fake.messages).toHaveLength(1);
  });

  it("trello: replay after a provider timeout produces exactly one card", async () => {
    process.env.GOATCITADEL_TRELLO_API_BASE_URL = TRELLO_BASE;
    const cards: Array<{ id: string; desc: string; shortUrl: string }> = [];
    let creates = 0;
    const harness = await createHarness(
      connectionFor("productivity.trello", { apiKey: "trello-key", token: "trello-token", defaultListId: "list-1" }),
      async (url, init) => {
        const parsed = new URL(url);
        if (init?.method === "POST" && parsed.pathname === "/1/cards") {
          creates += 1;
          cards.push({
            id: `card-${creates}`,
            desc: parsed.searchParams.get("desc") ?? "",
            shortUrl: "https://t.test/c",
          });
          throw timeoutError();
        }
        if (init?.method === "GET" && parsed.pathname === "/1/lists/list-1/cards/all") {
          return jsonResponse(cards);
        }
        return jsonResponse({ message: "unexpected" }, 404);
      },
    );

    const live = await invokeIntegrationConnectionAction(harness.host, "conn-trello", "write", {
      idempotencyKey: "idem-trello-1",
      input: { name: "Replay proof", desc: "Created exactly once." },
    });
    expect(live.status).toBe("failed");
    const run = await harness.readRun();
    expect(run.status).toBe("unknown_external_outcome");

    const results = await harness.replay(run);

    expect(results).toMatchObject([{ status: "reconciled", externalReferenceId: "id:card-1" }]);
    expect(await harness.readRun()).toMatchObject({ status: "completed" });
    expect(creates).toBe(1);
    expect(cards).toHaveLength(1);
  });

  describe("local bridge", () => {
    function createFakeBridge() {
      const effects = new Map<string, { noteId: string }>();
      const keys: string[] = [];
      const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
        expect(url).toBe(`${BRIDGE_URL}/v1/integrations/actions`);
        const key = String((init?.headers as Record<string, string>)["Idempotency-Key"]);
        keys.push(key);
        const existing = effects.get(key);
        if (existing) {
          return jsonResponse({ ok: true, deduplicated: true, ...existing });
        }
        effects.set(key, { noteId: `note-${effects.size + 1}` });
        throw timeoutError();
      };
      return { fetchImpl, effects, keys };
    }

    async function liveTimedOutBridgeWrite(config: Record<string, unknown>) {
      const bridge = createFakeBridge();
      const harness = await createHarness(connectionFor("productivity.apple-notes", config), bridge.fetchImpl);
      const live = await invokeIntegrationConnectionAction(harness.host, "conn-apple-notes", "write", {
        idempotencyKey: "idem-bridge-1",
        input: { title: "Replay proof", content: "Written exactly once." },
      });
      expect(live.status).toBe("failed");
      const run = await harness.readRun();
      expect(run.status).toBe("unknown_external_outcome");
      return { harness, bridge, run };
    }

    it("an enforcing bridge reconciles a timed-out write with the same Idempotency-Key", async () => {
      const { harness, bridge, run } = await liveTimedOutBridgeWrite({
        bridgeUrl: BRIDGE_URL,
        idempotencyKeyEnforced: "true",
      });

      const results = await harness.replay(run);

      expect(results).toMatchObject([{ status: "reconciled" }]);
      expect(await harness.readRun()).toMatchObject({ status: "completed" });
      // The bridge receives the scoped digest (route + actor + key), never the raw key.
      const scopedKey = deriveLocalBridgeIdempotencyKey(run);
      expect(scopedKey).toMatch(/^[a-f0-9]{64}$/);
      expect(bridge.keys).toEqual([scopedKey, scopedKey]);
      expect(bridge.effects.size).toBe(1);
    });

    it("a non-enforcing bridge stays in manual review", async () => {
      const { harness, bridge, run } = await liveTimedOutBridgeWrite({ bridgeUrl: BRIDGE_URL });

      const results = await harness.replay(run);

      expect(results).toMatchObject([{ status: "skipped", reason: "external_boundary_already_crossed" }]);
      expect(await harness.readRun()).toMatchObject({ status: "unknown_external_outcome" });
      expect(bridge.keys).toHaveLength(1);
    });
  });

  it("gmail: a pre-boundary failure replays from the sealed record and sends once", async () => {
    const { harness, fake, run } = await gmailPreBoundaryHarness();

    const results = await harness.replay(run);

    expect(results).toMatchObject([{ status: "executed" }]);
    expect(await harness.readRun()).toMatchObject({ status: "completed" });
    expect(fake.sendCount()).toBe(1);
    expect(fake.messages[0]?.messageId).toMatch(/^gc-[a-f0-9]{32}@goatcitadel\.local$/);
  });

  it("refuses replay when the sealed payload was tampered", async () => {
    const { harness, fake, run } = await gmailPreBoundaryHarness();
    const row = harness.storage.db
      .prepare("SELECT replay_record_json FROM external_side_effect_runs WHERE run_id = ?")
      .get(run.runId) as { replay_record_json: string };
    const record = JSON.parse(row.replay_record_json) as { ciphertext: string };
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    harness.storage.db
      .prepare("UPDATE external_side_effect_runs SET replay_record_json = ? WHERE run_id = ?")
      .run(JSON.stringify({ ...record, ciphertext: ciphertext.toString("base64") }), run.runId);

    const results = await harness.replay(run);

    expect(results).toMatchObject([{ status: "skipped", reason: "job_unavailable" }]);
    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(fake.sendCount()).toBe(0);
  });

  it("refuses replay when the sealed payload no longer hashes to the run", async () => {
    const { harness, fake, run } = await gmailPreBoundaryHarness();
    // The record still opens (same run id + payload hash), but the LIVE destination moved,
    // so the rebuilt input's fingerprint no longer reproduces the recorded payload hash.
    process.env.GOATCITADEL_GMAIL_API_BASE_URL = GMAIL_BASE_B;
    const open = vi.spyOn(harness.host.replayRecords!, "open");

    expect(await buildGatewayExternalSideEffectReplayJob(harness.host, run, payload)).toBeUndefined();
    // The sealed record DID open, so the refusal is the payload-hash check, not a missing record.
    expect(open).toHaveBeenCalledTimes(1);
    await expect(open.mock.results[0]!.value).resolves.toMatchObject({
      payload: { provider: "gmail", to: gmailRequest.input.to },
    });
    expect(await harness.replay(run)).toMatchObject([{ status: "skipped", reason: "job_unavailable" }]);
    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(fake.sendCount()).toBe(0);
  });

  it("refuses replay when the live connection lost its credentials", async () => {
    const { harness, run } = await gmailPreBoundaryHarness();
    harness.setConnection(connectionFor("automation.gmail", {}));

    expect(await buildGatewayExternalSideEffectReplayJob(harness.host, run, payload)).toBeUndefined();
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it("refuses replay when the host has no replay records", async () => {
    const { harness, run } = await gmailPreBoundaryHarness();
    const host: IntegrationActionHost = { ...harness.host, replayRecords: undefined };

    expect(await buildGatewayExternalSideEffectReplayJob(host, run, payload)).toBeUndefined();
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });
});
