import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { invokeIntegrationConnectionAction, type IntegrationActionHost } from "./integration-action-service.js";

function createConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "productivity.apple-notes",
    kind: "productivity",
    key: "apple-notes",
    label: "Apple Notes",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function createHost(
  connection: IntegrationConnection,
  overrides: Partial<IntegrationActionHost> = {},
): IntegrationActionHost {
  return {
    storage: {
      integrationConnections: {
        get: vi.fn(() => connection),
      },
    },
    fetchWithDiagnosticsTimeout: vi.fn(),
    readConnectionConfigValue: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn((config: Record<string, unknown>, directKey: string, envKey: string) => {
      const direct = config[directKey];
      if (typeof direct === "string" && direct.length > 0) {
        return direct;
      }
      const envValue = config[envKey];
      return typeof envValue === "string" && envValue.length > 0 ? envValue : undefined;
    }),
    publishRealtime: vi.fn(),
    mutationStore: {
      claim: vi.fn((input) => ({
        outcome: "claimed" as const,
        record: {
          method: input.method,
          routePath: input.routePath,
          idempotencyKey: input.idempotencyKey,
          actorScope: input.actorScope ?? "",
          payloadHash: input.payloadHash,
          status: "pending" as const,
          createdAt: input.now ?? "2026-04-10T12:00:00.000Z",
          updatedAt: input.now ?? "2026-04-10T12:00:00.000Z",
        },
      })),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    },
    ...overrides,
  };
}

describe("integration-action-service", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dispatches local bridge actions through the configured bridge endpoint", async () => {
    const connection = createConnection({
      config: {
        bridgeUrl: "http://127.0.0.1:4040",
        authToken: "secret-token",
      },
    });
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: "bridge ok",
              output: {
                items: [{ title: "Sample note" }],
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "read");

    expect(result.status).toBe("executed");
    expect(result.message).toContain("bridge ok");
    expect(host.fetchWithDiagnosticsTimeout).toHaveBeenCalledWith(
      "http://127.0.0.1:4040/v1/integrations/actions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
        }),
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalled();
  });

  it("runs local bridge write actions through the shared idempotency guard", async () => {
    const connection = createConnection({
      config: {
        bridgeUrl: "http://127.0.0.1:4040",
      },
    });
    const createEnvelope = vi.fn(() => ({
      envelopeId: "env-local-bridge-write",
      eventKind: "external_writeback",
      contentHash: "content-hash",
      payloadHash: "payload-hash",
      toolCallHashes: [],
      memoryLineage: [],
      signatureStatus: "unsigned_local",
      metadata: {},
      createdAt: "2026-04-10T12:00:00.000Z",
    }));
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: "note created",
              output: {
                id: "note-1",
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
      evidenceEnvelopeService: { createEnvelope } as never,
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
      idempotencyKey: "local-bridge-key",
      input: { title: "Governed note", content: "Created once." },
    });

    expect(result).toMatchObject({
      status: "executed",
      output: {
        provider: "local_bridge",
        catalogId: "productivity.apple-notes",
        actionId: "write",
        id: "note-1",
        replayPolicy: "idempotent_external",
        replayOutcome: "claimed",
        idempotencyKey: "local-bridge-key",
      },
      durableWriteback: {
        status: "recorded",
        replayPolicy: "idempotent_external",
        replayOutcome: "claimed",
        envelopeId: "env-local-bridge-write",
      },
    });
    expect(host.mutationStore?.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        routePath: expect.stringContaining("integration_local_bridge_action"),
        idempotencyKey: "local-bridge-key",
        actorScope: connection.connectionId,
      }),
    );
    expect(host.mutationStore?.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "local-bridge-key",
        actorScope: connection.connectionId,
      }),
    );
  });

  it("does not send duplicate local bridge writes across the bridge boundary", async () => {
    const connection = createConnection({
      config: {
        bridgeUrl: "http://127.0.0.1:4040",
      },
    });
    const fetchMock = vi.fn();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
      evidenceEnvelopeService: {
        createEnvelope: vi.fn(() => ({
          envelopeId: "env-local-bridge-duplicate",
          eventKind: "external_writeback",
          contentHash: "content-hash",
          payloadHash: "payload-hash",
          toolCallHashes: [],
          memoryLineage: [],
          signatureStatus: "unsigned_local",
          metadata: {},
          createdAt: "2026-04-10T12:00:00.000Z",
        })),
      } as never,
      mutationStore: {
        claim: vi.fn(() => ({
          outcome: "duplicate" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "local-bridge-key",
            actorScope: connection.connectionId,
            payloadHash: "payload-hash",
            status: "completed" as const,
            createdAt: "2026-04-10T12:00:00.000Z",
            updatedAt: "2026-04-10T12:00:01.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed: vi.fn(),
      },
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
      idempotencyKey: "local-bridge-key",
      input: { title: "Governed note", content: "Created once." },
    });

    expect(result).toMatchObject({
      status: "blocked",
      blockedReason: "external_side_effect_duplicate",
      output: {
        provider: "local_bridge",
        catalogId: "productivity.apple-notes",
        actionId: "write",
        replayPolicy: "idempotent_external",
        replayOutcome: "duplicate",
        idempotencyKey: "local-bridge-key",
      },
      durableWriteback: {
        status: "recorded",
        replayPolicy: "idempotent_external",
        replayOutcome: "duplicate",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.mutationStore?.markCompleted).not.toHaveBeenCalled();
  });

  it("executes Trello read and write actions through the core-native Trello runtime", async () => {
    const connection = createConnection({
      catalogId: "productivity.trello",
      key: "trello",
      label: "Trello",
      config: {
        apiKey: "trello-key",
        token: "trello-token",
        defaultListId: "list-123",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "board-1", name: "Alpha board" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "card-1", name: "GoatCitadel operator card" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
    });

    const readResult = await invokeIntegrationConnectionAction(host, connection.connectionId, "read");
    const writeResult = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
      input: { name: "GoatCitadel operator card" },
    });

    expect(readResult.status).toBe("executed");
    expect(readResult.output?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Alpha board" })]),
    );
    expect(writeResult.status).toBe("executed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records replay-safe durable envelopes for core-native external writeback actions", async () => {
    const connection = createConnection({
      catalogId: "productivity.trello",
      key: "trello",
      label: "Trello",
      config: {
        apiKey: "trello-key",
        token: "trello-token",
        defaultListId: "list-123",
      },
    });
    const createEnvelope = vi.fn(() => ({
      envelopeId: "env-writeback-1",
      eventKind: "external_writeback",
      contentHash: "content-hash",
      payloadHash: "payload-hash",
      toolCallHashes: [],
      memoryLineage: [],
      signatureStatus: "unsigned_local",
      metadata: {},
      createdAt: "2026-04-10T12:00:00.000Z",
    }));
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "card-1", url: "https://trello.example.test/c/card-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      evidenceEnvelopeService: { createEnvelope } as never,
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
      input: { name: "Durable card" },
    });

    expect(result.durableWriteback).toEqual(
      expect.objectContaining({
        status: "recorded",
        replayPolicy: "idempotent_external",
        replayOutcome: "claimed",
        resumable: false,
        envelopeId: "env-writeback-1",
        contentHash: "content-hash",
        signatureStatus: "unsigned_local",
        intentId: expect.stringMatching(/^external-side-effect-/),
        idempotencyKey: expect.any(String),
      }),
    );
    expect(createEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "external_writeback",
        metadata: expect.objectContaining({
          boundary: "integration_operator_action",
          externalSideEffect: true,
          externalSideEffectIntentId: expect.stringMatching(/^external-side-effect-/),
          externalSideEffectIdempotencyKey: expect.any(String),
          replayPolicy: "idempotent_external",
          replayOutcome: "claimed",
          payloadHash: expect.any(String),
          resumable: false,
          connectionId: connection.connectionId,
          catalogId: "productivity.trello",
          actionId: "write",
          status: "executed",
          inputKeys: ["name"],
          outputKeys: expect.arrayContaining([
            "id",
            "url",
            "replayPolicy",
            "replayOutcome",
            "idempotencyKey",
            "payloadHash",
          ]),
          externalReferenceId: "id:card-1",
        }),
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "system",
      "integrations",
      expect.objectContaining({
        durableWritebackStatus: "recorded",
        durableWritebackEnvelopeId: "env-writeback-1",
      }),
    );
  });

  it.each([
    {
      label: "Trello",
      outcome: "duplicate" as const,
      connection: createConnection({
        catalogId: "productivity.trello",
        key: "trello",
        label: "Trello",
        config: {
          apiKey: "trello-key",
          token: "trello-token",
          defaultListId: "list-123",
        },
      }),
      input: { name: "Durable card" },
    },
    {
      label: "Gmail",
      outcome: "payload_mismatch" as const,
      connection: createConnection({
        catalogId: "automation.gmail",
        key: "gmail",
        kind: "automation",
        label: "Gmail",
        config: {
          accessToken: "gmail-token",
        },
      }),
      input: {
        to: "ops@example.com",
        subject: "GoatCitadel operator check",
        bodyText: "This is a GoatCitadel Gmail operator check.",
      },
    },
  ])(
    "does not send $label writes when the shared idempotency runner reports $outcome",
    async ({ connection, input, outcome }) => {
      const fetchMock = vi.fn();
      const host = createHost(connection, {
        fetchWithDiagnosticsTimeout: fetchMock,
        evidenceEnvelopeService: {
          createEnvelope: vi.fn(() => ({
            envelopeId: `env-${connection.key}-${outcome}`,
            eventKind: "external_writeback",
            contentHash: "content-hash",
            payloadHash: "payload-hash",
            toolCallHashes: [],
            memoryLineage: [],
            signatureStatus: "unsigned_local",
            metadata: {},
            createdAt: "2026-04-10T12:00:00.000Z",
          })),
        } as never,
        mutationStore: {
          claim: vi.fn(() => ({
            outcome,
            record: {
              method: "POST",
              routePath: "external",
              idempotencyKey: "operator-key",
              actorScope: connection.connectionId,
              payloadHash: "payload-hash",
              status: outcome === "duplicate" ? ("completed" as const) : ("pending" as const),
              createdAt: "2026-04-10T12:00:00.000Z",
              updatedAt: "2026-04-10T12:00:01.000Z",
            },
          })),
          markCompleted: vi.fn(),
          markFailed: vi.fn(),
        },
      });

      const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
        idempotencyKey: "operator-key",
        input,
      });

      expect(result).toMatchObject({
        status: "blocked",
        blockedReason: `external_side_effect_${outcome}`,
        output: {
          replayPolicy: "idempotent_external",
          replayOutcome: outcome,
          idempotencyKey: "operator-key",
        },
        durableWriteback: {
          status: "recorded",
          replayPolicy: "idempotent_external",
          replayOutcome: outcome,
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(host.mutationStore?.markCompleted).not.toHaveBeenCalled();
    },
  );

  it("marks replay-safe external writeback claims failed when a provider write fails", async () => {
    const connection = createConnection({
      catalogId: "productivity.trello",
      key: "trello",
      label: "Trello",
      config: {
        apiKey: "trello-key",
        token: "trello-token",
        defaultListId: "list-123",
      },
    });
    const markFailed = vi.fn();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("board archived", { status: 409 })),
      mutationStore: {
        claim: vi.fn((input) => ({
          outcome: "claimed" as const,
          record: {
            method: input.method,
            routePath: input.routePath,
            idempotencyKey: input.idempotencyKey,
            actorScope: input.actorScope ?? "",
            payloadHash: input.payloadHash,
            status: "pending" as const,
            createdAt: input.now ?? "2026-04-10T12:00:00.000Z",
            updatedAt: input.now ?? "2026-04-10T12:00:00.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed,
      },
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
      idempotencyKey: "operator-key",
      input: { name: "Durable card" },
    });

    expect(result).toMatchObject({
      status: "failed",
      message: "board archived",
      output: {
        replayPolicy: "idempotent_external",
        replayOutcome: "claimed",
        replayAttempt: "new",
        resumable: false,
        resumeState: "manual_retry_after_recorded_failure",
        idempotencyKey: "operator-key",
      },
      durableWriteback: {
        status: "unavailable",
        replayPolicy: "idempotent_external",
        replayOutcome: "claimed",
        resumable: false,
        resumeState: "manual_retry_after_recorded_failure",
      },
    });
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "operator-key",
        actorScope: connection.connectionId,
      }),
    );
    expect(host.mutationStore?.markCompleted).not.toHaveBeenCalled();
  });

  it("triggers Activepieces webhooks with idempotent external writeback evidence", async () => {
    const connection = createConnection({
      catalogId: "automation.activepieces",
      key: "activepieces",
      label: "Activepieces",
      config: {
        webhookUrl: "https://activepieces.example.test/hooks/flow-1",
        authToken: "secret-token",
        defaultFlowId: "flow-1",
      },
    });
    const createEnvelope = vi.fn(() => ({
      envelopeId: "env-activepieces-1",
      eventKind: "external_writeback",
      contentHash: "content-hash",
      payloadHash: "payload-hash",
      toolCallHashes: [],
      memoryLineage: [],
      signatureStatus: "unsigned_local",
      metadata: {},
      createdAt: "2026-04-10T12:00:00.000Z",
    }));
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "run-1", message: "flow accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
      evidenceEnvelopeService: { createEnvelope } as never,
      mutationStore: {
        claim: vi.fn(() => ({
          outcome: "claimed" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "activepieces-key",
            actorScope: connection.connectionId,
            payloadHash: "payload-hash",
            status: "pending" as const,
            createdAt: "2026-04-10T12:00:00.000Z",
            updatedAt: "2026-04-10T12:00:00.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed: vi.fn(),
      },
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "trigger_webhook", {
      input: {
        payload: '{"message":"Operator approved flow trigger"}',
      },
    });

    expect(result).toMatchObject({
      status: "executed",
      catalogId: "automation.activepieces",
      actionId: "trigger_webhook",
      output: {
        provider: "activepieces",
        flowId: "flow-1",
      },
      durableWriteback: {
        status: "recorded",
        replayPolicy: "idempotent_external",
        replayOutcome: "claimed",
        resumable: false,
        envelopeId: "env-activepieces-1",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://activepieces.example.test/hooks/flow-1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
        }),
      }),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      source: "goatcitadel",
      checkedAt: expect.any(String),
      flowId: "flow-1",
      payload: {
        message: "Operator approved flow trigger",
      },
    });
    expect(createEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "external_writeback",
        metadata: expect.objectContaining({
          catalogId: "automation.activepieces",
          integrationKey: "activepieces",
          actionId: "trigger_webhook",
          replayPolicy: "idempotent_external",
          replayOutcome: "claimed",
          payloadHash: expect.any(String),
          resumable: false,
          externalReferenceId: "id:run-1",
        }),
      }),
    );
    expect(host.mutationStore?.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        actorScope: connection.connectionId,
      }),
    );
  });

  it("does not resend Activepieces webhooks when the idempotency claim is duplicate", async () => {
    const connection = createConnection({
      catalogId: "automation.activepieces",
      key: "activepieces",
      label: "Activepieces",
      config: {
        webhookUrl: "https://activepieces.example.test/hooks/flow-1",
        defaultFlowId: "flow-1",
      },
    });
    const fetchMock = vi.fn();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
      evidenceEnvelopeService: {
        createEnvelope: vi.fn(() => ({
          envelopeId: "env-activepieces-duplicate",
          eventKind: "external_writeback",
          contentHash: "content-hash",
          payloadHash: "payload-hash",
          toolCallHashes: [],
          memoryLineage: [],
          signatureStatus: "unsigned_local",
          metadata: {},
          createdAt: "2026-04-10T12:00:00.000Z",
        })),
      } as never,
      mutationStore: {
        claim: vi.fn(() => ({
          outcome: "duplicate" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: connection.connectionId,
            payloadHash: "payload-hash",
            status: "completed" as const,
            createdAt: "2026-04-10T12:00:00.000Z",
            updatedAt: "2026-04-10T12:00:01.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed: vi.fn(),
      },
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "trigger_webhook", {
      idempotencyKey: "operator-key",
      input: {
        payload: '{"message":"Operator approved flow trigger"}',
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      blockedReason: "external_side_effect_duplicate",
      output: {
        replayPolicy: "idempotent_external",
        replayOutcome: "duplicate",
        idempotencyKey: "operator-key",
      },
      durableWriteback: {
        status: "recorded",
        replayPolicy: "idempotent_external",
        replayOutcome: "duplicate",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.mutationStore?.markCompleted).not.toHaveBeenCalled();
  });

  it.each(["in_progress", "payload_mismatch"] as const)(
    "does not resend Activepieces webhooks when the idempotency claim is %s",
    async (outcome) => {
      const connection = createConnection({
        catalogId: "automation.activepieces",
        key: "activepieces",
        label: "Activepieces",
        config: {
          webhookUrl: "https://activepieces.example.test/hooks/flow-1",
          defaultFlowId: "flow-1",
        },
      });
      const fetchMock = vi.fn();
      const host = createHost(connection, {
        fetchWithDiagnosticsTimeout: fetchMock,
        evidenceEnvelopeService: {
          createEnvelope: vi.fn(() => ({
            envelopeId: `env-activepieces-${outcome}`,
            eventKind: "external_writeback",
            contentHash: "content-hash",
            payloadHash: "payload-hash",
            toolCallHashes: [],
            memoryLineage: [],
            signatureStatus: "unsigned_local",
            metadata: {},
            createdAt: "2026-04-10T12:00:00.000Z",
          })),
        } as never,
        mutationStore: {
          claim: vi.fn(() => ({
            outcome,
            record: {
              method: "POST",
              routePath: "external",
              idempotencyKey: "operator-key",
              actorScope: connection.connectionId,
              payloadHash: "payload-hash",
              status: outcome === "in_progress" ? ("pending" as const) : ("completed" as const),
              createdAt: "2026-04-10T12:00:00.000Z",
              updatedAt: "2026-04-10T12:00:01.000Z",
            },
          })),
          markCompleted: vi.fn(),
          markFailed: vi.fn(),
        },
      });

      const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "trigger_webhook", {
        idempotencyKey: "operator-key",
        input: {
          payload: '{"message":"Operator approved flow trigger"}',
        },
      });

      expect(result).toMatchObject({
        status: "blocked",
        blockedReason: `external_side_effect_${outcome}`,
        output: {
          replayPolicy: "idempotent_external",
          replayOutcome: outcome,
          idempotencyKey: "operator-key",
        },
        durableWriteback: {
          status: "recorded",
          replayPolicy: "idempotent_external",
          replayOutcome: outcome,
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(host.mutationStore?.markCompleted).not.toHaveBeenCalled();
    },
  );

  it("blocks Activepieces webhook triggers until a webhook URL is configured", async () => {
    const connection = createConnection({
      catalogId: "automation.activepieces",
      key: "activepieces",
      label: "Activepieces",
    });
    const host = createHost(connection);

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "trigger_webhook");

    expect(result).toMatchObject({
      status: "blocked",
      blockedReason: "activepieces_webhook_missing",
      durableWriteback: {
        status: "unavailable",
        replayPolicy: "audit_only",
        resumable: false,
      },
    });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("falls back between local bridge endpoints and reports the final bridge failure context", async () => {
    const connection = createConnection({
      config: {
        bridgeUrl: "http://127.0.0.1:4040/",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "legacy endpoint unavailable" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("bridge offline", { status: 503 }));
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "read", {
      input: { limit: 2 },
    });

    expect(result).toMatchObject({
      status: "failed",
      message: "bridge offline",
      output: {
        bridgeUrl: "http://127.0.0.1:4040/",
      },
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:4040/v1/integrations/actions",
      "http://127.0.0.1:4040/api/v1/integrations/actions",
    ]);
  });

  it("returns readable blocked output when GIF search is visible but not configured", async () => {
    const connection = createConnection({
      catalogId: "automation.gif-search",
      key: "gif-search",
      kind: "automation",
      label: "GIF Search",
      config: {
        provider: "tenor",
      },
    });
    const host = createHost(connection);

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "search", {
      input: { query: "goat" },
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("gif_api_key_missing");
    expect(result.message).toContain("API key");
  });

  it("normalizes Tenor and Giphy GIF search results from provider-specific payloads", async () => {
    vi.stubEnv("GOATCITADEL_TENOR_API_BASE_URL", "https://tenor.example.test");
    vi.stubEnv("GOATCITADEL_GIPHY_API_BASE_URL", "https://giphy.example.test");
    const tenorConnection = createConnection({
      catalogId: "automation.gif-search",
      key: "gif-search",
      kind: "automation",
      label: "GIF Search",
      config: {
        provider: "tenor",
        apiKey: "tenor-key",
        defaultLocale: "en_GB",
      },
    });
    const giphyConnection = createConnection({
      ...tenorConnection,
      connectionId: "22222222-2222-2222-2222-222222222222",
      config: {
        provider: "giphy",
        apiKey: "giphy-key",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "tenor-1",
                content_description: "Goat wave",
                media_formats: {
                  tinygif: { url: "https://cdn.example.test/tiny.gif" },
                  gif: { url: "https://cdn.example.test/full.gif" },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "giphy-1",
                title: "Goat salute",
                images: {
                  fixed_height: { url: "https://cdn.example.test/fixed.gif" },
                  original: { url: "https://cdn.example.test/original.gif" },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const tenor = await invokeIntegrationConnectionAction(
      createHost(tenorConnection, { fetchWithDiagnosticsTimeout: fetchMock }),
      tenorConnection.connectionId,
      "search",
      { input: { query: "ops check" } },
    );
    const giphy = await invokeIntegrationConnectionAction(
      createHost(giphyConnection, { fetchWithDiagnosticsTimeout: fetchMock }),
      giphyConnection.connectionId,
      "search",
      { input: { query: "ops check" } },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://tenor.example.test/v2/search?key=tenor-key&q=ops+check&limit=5&locale=en_GB",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://giphy.example.test/v1/gifs/search?api_key=giphy-key&q=ops+check&limit=5&rating=pg-13",
    );
    expect(tenor.output?.items).toEqual([
      {
        id: "tenor-1",
        title: "Goat wave",
        url: "https://cdn.example.test/full.gif",
      },
    ]);
    expect(giphy.output?.items).toEqual([
      {
        id: "giphy-1",
        title: "Goat salute",
        url: "https://cdn.example.test/original.gif",
      },
    ]);
  });

  it("executes Gmail read and write actions through the core-native Gmail runtime", async () => {
    const connection = createConnection({
      catalogId: "automation.gmail",
      key: "gmail",
      kind: "automation",
      label: "Gmail",
      config: {
        accessToken: "gmail-token",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "msg-1", threadId: "thread-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "sent-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
    });

    const readResult = await invokeIntegrationConnectionAction(host, connection.connectionId, "read", {
      input: { query: "label:inbox" },
    });
    const writeResult = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
      input: {
        to: "ops@example.com",
        subject: "GoatCitadel operator check",
        bodyText: "This is a GoatCitadel Gmail operator check.",
      },
    });

    expect(readResult.status).toBe("executed");
    expect(readResult.output?.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "msg-1" })]));
    expect(writeResult.status).toBe("executed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks incomplete Gmail writes and surfaces provider read failures", async () => {
    const connection = createConnection({
      catalogId: "automation.gmail",
      key: "gmail",
      kind: "automation",
      label: "Gmail",
      config: {
        accessToken: "gmail-token",
      },
    });
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("quota exceeded", { status: 429 })),
    });

    await expect(
      invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
        input: {
          to: "ops@example.com",
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      blockedReason: "gmail_message_incomplete",
    });
    await expect(invokeIntegrationConnectionAction(host, connection.connectionId, "read")).resolves.toMatchObject({
      status: "failed",
      message: "quota exceeded",
      output: {
        provider: "gmail",
      },
    });
  });
});
