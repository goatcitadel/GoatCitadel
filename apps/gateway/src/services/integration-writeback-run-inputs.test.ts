import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection, IntegrationOperatorAction } from "@goatcitadel/contracts";
import type { IntegrationActionHost } from "./integration-action-service.js";
import {
  fingerprintExternalSideEffectDestination,
  type ExternalSideEffectExecutionContext,
} from "./external-side-effect-runner-service.js";
import {
  buildGmailSendRunInput,
  buildLocalBridgeWriteRunInput,
  buildTrelloCardCreateRunInput,
  deriveGmailMessageId,
  deriveLocalBridgeIdempotencyKey,
  deriveTrelloIdempotencyMarker,
  ProviderAuthRejectedError,
  type WritebackDedupeScope,
} from "./integration-writeback-run-inputs.js";

const CHECKED_AT = "2026-10-16T12:00:00.000Z";

function createConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "automation.gmail",
    kind: "automation",
    key: "gmail",
    label: "Gmail",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function createHost(
  responses: Response[],
  overrides: Partial<IntegrationActionHost> = {},
): IntegrationActionHost & { calls: Array<{ url: string; init?: RequestInit }>; order: string[] } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const order: string[] = [];
  const queue = [...responses];
  return {
    calls,
    order,
    storage: {
      integrationConnections: { get: vi.fn() },
      runImmediateTransaction: vi.fn(<T>(work: () => T): T => work()),
    },
    fetchWithDiagnosticsTimeout: vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      order.push(`fetch:${init?.method ?? "GET"}`);
      const next = queue.shift();
      if (!next) {
        throw new Error("unexpected fetch");
      }
      return next;
    }),
    readConnectionConfigValue: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn((config: Record<string, unknown>, directKey: string) => {
      const value = config[directKey];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    }),
    publishRealtime: vi.fn(),
    mutationStore: {} as IntegrationActionHost["mutationStore"],
    sideEffectRunStore: {} as IntegrationActionHost["sideEffectRunStore"],
    replayRecords: {
      seal: vi.fn(async () => {
        order.push("seal");
        return true;
      }),
      open: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

function createClaim(order: string[], overrides: Partial<ExternalSideEffectExecutionContext> = {}) {
  return {
    replayPolicy: "idempotent_external",
    replayOutcome: "claimed",
    replayAttempt: "new",
    resumable: false,
    resumeState: "in_progress",
    idempotencyKey: "operator-key-1",
    payloadHash: "payload-hash-1",
    actorScope: "scope",
    routePath: "external",
    sideEffectRunId: "extfx-run-1",
    externalCallStarted: false,
    externalCallNotRequired: false,
    markExternalCallStarted: vi.fn(async () => {
      order.push("markExternalCallStarted");
    }),
    markExternalCallNotRequired: vi.fn(() => {
      order.push("markExternalCallNotRequired");
    }),
    ...overrides,
  } as ExternalSideEffectExecutionContext & {
    markExternalCallStarted: ReturnType<typeof vi.fn>;
    markExternalCallNotRequired: ReturnType<typeof vi.fn>;
  };
}

function expectInput<T extends object>(parts: T | { blockedReason: string; message: string }): T {
  if ("blockedReason" in parts) {
    throw new Error(`unexpected blocked parts: ${parts.blockedReason}`);
  }
  return parts;
}

function decodeRaw(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body)) as { raw: string };
  return Buffer.from(body.raw, "base64url").toString("utf8");
}

const gmailConnection = () => createConnection({ config: { accessToken: "gmail-token" } });
const gmailPayload = { provider: "gmail" as const, to: "ops@example.com", subject: "Hello", bodyText: "Body" };

const trelloConnection = () =>
  createConnection({
    catalogId: "productivity.trello",
    kind: "productivity",
    key: "trello",
    label: "Trello",
    config: { apiKey: "trello-key", token: "trello-token" },
  });
const trelloPayload = { provider: "trello" as const, listId: "list-1", name: "Card", desc: "Card body" };

const bridgeConnection = (config: Record<string, unknown> = {}) =>
  createConnection({
    catalogId: "productivity.apple-notes",
    kind: "productivity",
    key: "apple-notes",
    label: "Apple Notes",
    config: { bridgeUrl: "http://127.0.0.1:4040", ...config },
  });
const bridgeAction: IntegrationOperatorAction = {
  actionId: "write",
  label: "Create note",
  capability: "write",
} as IntegrationOperatorAction;
const bridgePayload = {
  provider: "local_bridge" as const,
  catalogId: "productivity.apple-notes",
  actionId: "write",
  input: { title: "Note" },
};

/** The dedupe scope the test claim (createClaim) carries. */
const CLAIM_SCOPE: WritebackDedupeScope = {
  routePath: "external",
  actorScope: "scope",
  idempotencyKey: "operator-key-1",
};

/** The runner's identity rule, spelled out independently: actor scope defaults to the connection id. */
function liveScope(connection: IntegrationConnection, boundary: string, actionId: string): WritebackDedupeScope {
  return {
    routePath: `external_side_effect:${boundary}:${connection.catalogId}:${connection.connectionId}:${actionId}`,
    actorScope: connection.connectionId,
    idempotencyKey: "operator-key-1",
  };
}

function scopedDigest(domain: string, scope: WritebackDedupeScope): string {
  return createHash("sha256")
    .update(`${domain}\0${JSON.stringify([scope.routePath, scope.actorScope, scope.idempotencyKey])}`)
    .digest("hex");
}

describe("integration-writeback-run-inputs", () => {
  it("derives stable provider dedupe identifiers from the scoped mutation identity", () => {
    const gmailDigest = scopedDigest("goatcitadel:gmail-message-id:v2", CLAIM_SCOPE).slice(0, 32);
    expect(deriveGmailMessageId(CLAIM_SCOPE)).toBe(`<gc-${gmailDigest}@goatcitadel.local>`);
    const trelloDigest = scopedDigest("goatcitadel:trello-marker:v2", CLAIM_SCOPE).slice(0, 32);
    expect(deriveTrelloIdempotencyMarker(CLAIM_SCOPE)).toBe(`[goatcitadel-idempotency:${trelloDigest}]`);
    expect(deriveLocalBridgeIdempotencyKey(CLAIM_SCOPE)).toBe(
      scopedDigest("goatcitadel:local-bridge-idempotency-key:v2", CLAIM_SCOPE),
    );
  });

  it("a key reused across connections or actor scopes yields different identifiers", () => {
    const otherConnection = { ...CLAIM_SCOPE, routePath: "external:other-connection" };
    const otherActor = { ...CLAIM_SCOPE, actorScope: "other-actor" };
    for (const derive of [deriveGmailMessageId, deriveTrelloIdempotencyMarker, deriveLocalBridgeIdempotencyKey]) {
      expect(derive(otherConnection)).not.toBe(derive(CLAIM_SCOPE));
      expect(derive(otherActor)).not.toBe(derive(CLAIM_SCOPE));
    }
    expect(deriveLocalBridgeIdempotencyKey(CLAIM_SCOPE)).not.toContain("operator-key-1");
  });

  it("the reconcile probe derives the same Message-ID the runner's claim sent", async () => {
    const connection = gmailConnection();
    const scope = liveScope(connection, "integration_operator_action", "write");
    const host = createHost([jsonResponse({ id: "msg-1" }), jsonResponse({ messages: [{ id: "msg-1" }] })]);
    const parts = expectInput(
      buildGmailSendRunInput(
        host,
        connection,
        {
          checkedAt: CHECKED_AT,
          payload: gmailPayload,
          idempotencyKey: "operator-key-1",
        },
        "gmail-token",
      ),
    );
    await parts.input.execute(createClaim(host.order, { routePath: scope.routePath, actorScope: scope.actorScope }));
    await parts.input.reconcileExternalOutcome!();

    const sentMessageId = decodeRaw(host.calls[0]!.init)
      .split("\r\n")
      .find((line) => line.startsWith("Message-ID: "))!
      .slice("Message-ID: ".length);
    expect(sentMessageId).toBe(deriveGmailMessageId(scope));
    expect(new URL(host.calls[1]!.url).searchParams.get("q")).toBe(
      `rfc822msgid:${sentMessageId.replace(/^<|>$/g, "")}`,
    );
  });

  it("gmail send carries the derived Message-ID", async () => {
    const host = createHost([jsonResponse({ id: "msg-1", threadId: "thread-1" })]);
    const parts = expectInput(
      buildGmailSendRunInput(host, gmailConnection(), { checkedAt: CHECKED_AT, payload: gmailPayload }, "gmail-token"),
    );
    expect(parts.target).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(parts.input.externalDestinationFingerprint).toBe(fingerprintExternalSideEffectDestination(parts.target));
    expect(parts.input.reconcileExternalOutcome).toBeTypeOf("function");
    const claim = createClaim(host.order);

    const value = await parts.input.execute(claim);

    expect(value.output).toEqual({ id: "msg-1", threadId: "thread-1" });
    expect(host.calls).toHaveLength(1);
    const raw = decodeRaw(host.calls[0]!.init);
    expect(raw.split("\r\n")).toContain(`Message-ID: ${deriveGmailMessageId(CLAIM_SCOPE)}`);
    expect(raw).toContain("To: ops@example.com");
    expect(raw.endsWith("\r\n\r\nBody")).toBe(true);
  });

  it("gmail probe searches by rfc822msgid", async () => {
    const host = createHost([jsonResponse({ messages: [{ id: "msg-9", threadId: "thread-9" }] })]);
    const parts = expectInput(
      buildGmailSendRunInput(
        host,
        gmailConnection(),
        {
          checkedAt: CHECKED_AT,
          payload: gmailPayload,
          idempotencyKey: "operator-key-1",
        },
        "gmail-token",
      ),
    );

    const probe = await parts.input.reconcileExternalOutcome!();

    expect(probe).toEqual({
      found: true,
      externalReferenceId: "messageId:msg-9",
      output: { id: "msg-9", threadId: "thread-9" },
    });
    const url = new URL(host.calls[0]!.url);
    expect(url.pathname).toBe("/gmail/v1/users/me/messages");
    const messageId = deriveGmailMessageId(
      liveScope(gmailConnection(), "integration_operator_action", "write"),
    ).replace(/^<|>$/g, "");
    expect(url.searchParams.get("q")).toBe(`rfc822msgid:${messageId}`);
    expect(url.searchParams.get("includeSpamTrash")).toBe("true");
    expect(url.searchParams.get("maxResults")).toBe("1");
    expect(host.calls[0]!.init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer gmail-token" } });
  });

  it("gmail probe reports not found and throws a generic error on a provider failure", async () => {
    const host = createHost([jsonResponse({}), jsonResponse({ error: "secret provider detail" }, 500)]);
    const parts = expectInput(
      buildGmailSendRunInput(
        host,
        gmailConnection(),
        {
          checkedAt: CHECKED_AT,
          payload: gmailPayload,
          idempotencyKey: "operator-key-1",
        },
        "gmail-token",
      ),
    );
    await expect(parts.input.reconcileExternalOutcome!()).resolves.toMatchObject({ found: false });
    const failure = await parts.input.reconcileExternalOutcome!().catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("secret provider detail");
  });

  it("gmail replay finds the sent message and does not resend", async () => {
    const host = createHost([jsonResponse({ messages: [{ id: "msg-1" }] })]);
    const parts = expectInput(
      buildGmailSendRunInput(
        host,
        gmailConnection(),
        {
          checkedAt: CHECKED_AT,
          payload: gmailPayload,
          idempotencyKey: "operator-key-1",
          replay: true,
        },
        "gmail-token",
      ),
    );
    const claim = createClaim(host.order);

    const value = await parts.input.execute(claim);

    expect(value.output).toEqual({ id: "msg-1" });
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]!.init?.method).toBe("GET");
    expect(claim.markExternalCallNotRequired).toHaveBeenCalledTimes(1);
    expect(claim.markExternalCallStarted).not.toHaveBeenCalled();
    expect(host.replayRecords!.seal).not.toHaveBeenCalled();
  });

  it("gmail replay throws before the boundary when the probe fails", async () => {
    const host = createHost([jsonResponse({}, 503)]);
    const parts = expectInput(
      buildGmailSendRunInput(
        host,
        gmailConnection(),
        { checkedAt: CHECKED_AT, payload: gmailPayload, replay: true },
        "gmail-token",
      ),
    );
    const claim = createClaim(host.order);

    await expect(parts.input.execute(claim)).rejects.toThrow();
    expect(claim.markExternalCallStarted).not.toHaveBeenCalled();
    expect(host.calls).toHaveLength(1);
  });

  it("gmail replay sends when the probe does not find the message", async () => {
    const host = createHost([jsonResponse({ resultSizeEstimate: 0 }), jsonResponse({ id: "msg-2" })]);
    const parts = expectInput(
      buildGmailSendRunInput(
        host,
        gmailConnection(),
        { checkedAt: CHECKED_AT, payload: gmailPayload, replay: true },
        "gmail-token",
      ),
    );
    const claim = createClaim(host.order);

    const value = await parts.input.execute(claim);

    expect(value.output).toEqual({ id: "msg-2" });
    expect(host.order).toEqual(["fetch:GET", "seal", "markExternalCallStarted", "fetch:POST"]);
  });

  it("trello create embeds the marker and fingerprints a secret-free destination", async () => {
    const host = createHost([jsonResponse({ id: "card-1", shortUrl: "https://trello.com/c/abc" })]);
    const parts = expectInput(
      buildTrelloCardCreateRunInput(host, trelloConnection(), { checkedAt: CHECKED_AT, payload: trelloPayload }),
    );
    expect(parts.input.externalDestinationFingerprint).toBe(
      fingerprintExternalSideEffectDestination("https://api.trello.com/1/cards"),
    );
    expect(parts.input.reconcileExternalOutcome).toBeTypeOf("function");
    const claim = createClaim(host.order);

    await parts.input.execute(claim);

    const sent = new URL(host.calls[0]!.url);
    expect(sent.pathname).toBe("/1/cards");
    expect(sent.searchParams.get("idList")).toBe("list-1");
    expect(sent.searchParams.get("name")).toBe("Card");
    expect(sent.searchParams.get("desc")).toBe(`Card body\n\n${deriveTrelloIdempotencyMarker(CLAIM_SCOPE)}`);
    expect(sent.searchParams.get("key")).toBe("trello-key");
    expect(sent.searchParams.get("token")).toBe("trello-token");
  });

  it("trello replay finds the marked card and does not recreate", async () => {
    const marker = deriveTrelloIdempotencyMarker(CLAIM_SCOPE);
    const host = createHost([
      jsonResponse([
        { id: "card-other", desc: "unrelated", shortUrl: "https://trello.com/c/other" },
        { id: "card-1", desc: `Card body\n\n${marker}`, shortUrl: "https://trello.com/c/abc" },
      ]),
    ]);
    const parts = expectInput(
      buildTrelloCardCreateRunInput(host, trelloConnection(), {
        checkedAt: CHECKED_AT,
        payload: trelloPayload,
        idempotencyKey: "operator-key-1",
        replay: true,
      }),
    );
    const claim = createClaim(host.order);

    const value = await parts.input.execute(claim);

    expect(value.output).toEqual({ id: "card-1", shortUrl: "https://trello.com/c/abc" });
    expect(host.calls).toHaveLength(1);
    const probeUrl = new URL(host.calls[0]!.url);
    expect(probeUrl.pathname).toBe("/1/lists/list-1/cards/all");
    expect(probeUrl.searchParams.get("fields")).toBe("id,desc,shortUrl");
    expect(probeUrl.searchParams.get("key")).toBe("trello-key");
    expect(probeUrl.searchParams.get("token")).toBe("trello-token");
    expect(claim.markExternalCallNotRequired).toHaveBeenCalledTimes(1);
    expect(claim.markExternalCallStarted).not.toHaveBeenCalled();
    expect(host.replayRecords!.seal).not.toHaveBeenCalled();
  });

  it("trello replay throws before the boundary when the probe fails", async () => {
    const host = createHost([jsonResponse({}, 503)]);
    const parts = expectInput(
      buildTrelloCardCreateRunInput(host, trelloConnection(), {
        checkedAt: CHECKED_AT,
        payload: trelloPayload,
        replay: true,
      }),
    );
    const claim = createClaim(host.order);

    await expect(parts.input.execute(claim)).rejects.toThrow();
    expect(claim.markExternalCallStarted).not.toHaveBeenCalled();
    expect(host.replayRecords!.seal).not.toHaveBeenCalled();
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]!.init?.method).toBe("GET");
  });

  it("trello probe reports the marked card id", async () => {
    const marker = deriveTrelloIdempotencyMarker(liveScope(trelloConnection(), "integration_operator_action", "write"));
    const host = createHost([jsonResponse([{ id: "card-1", desc: `x ${marker}`, shortUrl: "https://t/c/1" }])]);
    const parts = expectInput(
      buildTrelloCardCreateRunInput(host, trelloConnection(), {
        checkedAt: CHECKED_AT,
        payload: trelloPayload,
        idempotencyKey: "operator-key-1",
      }),
    );
    await expect(parts.input.reconcileExternalOutcome!()).resolves.toEqual({
      found: true,
      externalReferenceId: "id:card-1",
      output: { id: "card-1", shortUrl: "https://t/c/1" },
    });
  });

  it("local bridge sends the Idempotency-Key header", async () => {
    const host = createHost([jsonResponse({ message: "ok", output: { noteId: "n-1" } })]);
    const connection = bridgeConnection();
    const parts = expectInput(
      buildLocalBridgeWriteRunInput(host, connection, bridgeAction, { checkedAt: CHECKED_AT, payload: bridgePayload }),
    );
    expect(parts.target).toBe("http://127.0.0.1:4040/v1/integrations/actions");
    expect(parts.input.externalDestinationFingerprint).toBe(fingerprintExternalSideEffectDestination(parts.target));
    const claim = createClaim(host.order);

    const value = await parts.input.execute(claim);

    expect(value).toEqual({ message: "ok", output: { message: "ok", output: { noteId: "n-1" } } });
    expect(host.calls[0]!.url).toBe(parts.target);
    expect(host.calls[0]!.init?.headers).toMatchObject({
      "Idempotency-Key": deriveLocalBridgeIdempotencyKey(CLAIM_SCOPE),
    });
    expect(JSON.parse(String(host.calls[0]!.init?.body))).toEqual({
      integrationKey: connection.key,
      catalogId: connection.catalogId,
      connectionId: connection.connectionId,
      actionId: "write",
      input: { title: "Note" },
    });
  });

  it("local bridge probe exists only when the bridge enforces the key", async () => {
    const plainHost = createHost([]);
    const plain = expectInput(
      buildLocalBridgeWriteRunInput(plainHost, bridgeConnection(), bridgeAction, {
        checkedAt: CHECKED_AT,
        payload: bridgePayload,
      }),
    );
    expect(plain.input.reconcileExternalOutcome).toBeUndefined();
    expect(plain.input.providerIdempotencyKeyEnforced).toBeUndefined();

    const enforcedHost = createHost([jsonResponse({ message: "already done", output: { noteId: "n-1" } })]);
    const enforced = expectInput(
      buildLocalBridgeWriteRunInput(enforcedHost, bridgeConnection({ idempotencyKeyEnforced: "true" }), bridgeAction, {
        checkedAt: CHECKED_AT,
        payload: bridgePayload,
        idempotencyKey: "operator-key-1",
      }),
    );
    expect(enforced.input.providerIdempotencyKeyEnforced).toBe(true);
    const probe = await enforced.input.reconcileExternalOutcome!();
    expect(probe.found).toBe(true);
    expect(enforcedHost.calls[0]!.init).toMatchObject({
      method: "POST",
      headers: {
        "Idempotency-Key": deriveLocalBridgeIdempotencyKey(
          liveScope(bridgeConnection(), "integration_local_bridge_action", "write"),
        ),
      },
    });
  });

  it("seals the replay record before crossing the boundary", async () => {
    const host = createHost([jsonResponse({ id: "card-1" })]);
    const parts = expectInput(
      buildTrelloCardCreateRunInput(host, trelloConnection(), { checkedAt: CHECKED_AT, payload: trelloPayload }),
    );
    const claim = createClaim(host.order);

    await parts.input.execute(claim);

    expect(host.order).toEqual(["seal", "markExternalCallStarted", "fetch:POST"]);
    expect(host.replayRecords!.seal).toHaveBeenCalledWith({
      runId: "extfx-run-1",
      payloadHash: "payload-hash-1",
      payload: parts.input.payload,
    });
  });

  it("skips the seal when the claim has no side-effect run id", async () => {
    const host = createHost([jsonResponse({ id: "msg-1" })]);
    const parts = expectInput(
      buildGmailSendRunInput(host, gmailConnection(), { checkedAt: CHECKED_AT, payload: gmailPayload }, "gmail-token"),
    );

    await parts.input.execute(createClaim(host.order, { sideEffectRunId: undefined }));

    expect(host.replayRecords!.seal).not.toHaveBeenCalled();
    expect(host.order).toEqual(["markExternalCallStarted", "fetch:POST"]);
  });

  it("blocks when provider credentials are missing", () => {
    const host = createHost([]);
    expect(
      buildTrelloCardCreateRunInput(host, createConnection({ catalogId: "productivity.trello" }), {
        checkedAt: CHECKED_AT,
        payload: trelloPayload,
      }),
    ).toMatchObject({ blockedReason: "trello_auth_missing" });
    expect(
      buildLocalBridgeWriteRunInput(host, createConnection(), bridgeAction, {
        checkedAt: CHECKED_AT,
        payload: bridgePayload,
      }),
    ).toMatchObject({ blockedReason: "bridge_url_missing" });
  });
});

describe("ProviderAuthRejectedError", () => {
  it.each([401, 403] as const)("names the provider and the %s status without any credential", (status) => {
    const error = new ProviderAuthRejectedError("Notion", status);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Notion rejected the integration credentials (${status}).`);
    expect(error.provider).toBe("Notion");
    expect(error.status).toBe(status);
  });
});
