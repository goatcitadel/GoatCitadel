import { describe, expect, it } from "vitest";
import type { ExternalSideEffectRunRecord, IntegrationConnection } from "@goatcitadel/contracts";
import {
  preserveIntegrationConnectionSecretsForPublicUpdate,
  projectExternalSideEffectRunsForPublicResponse,
  projectIntegrationConnectionForPublicResponse,
} from "./integration-connection-public-projection.js";

function createConnection(): IntegrationConnection {
  return {
    connectionId: "11111111-1111-4111-8111-111111111111",
    catalogId: "channel.slack",
    kind: "channel",
    key: "slack",
    label: "Slack",
    enabled: true,
    status: "connected",
    config: {
      botToken: "bot-short",
      webhookUrl: "https://hooks.example.test/services/team?token=hook-short&mode=events",
      callbackUrl: "https://callback.example.test/events?token=callback-short&mode=events",
      callbackPathUrl: "https://callback.example.test/token/path-short?mode=events",
      headers: {
        Authorization: "Bearer tiny",
        "x-request-id": "request-123",
      },
      DATABASE_PASSWORD: "db-short",
      botTokenEnv: "SLACK_BOT_TOKEN",
      secretRef: "keychain:slack-bot-token",
      tokenId: "runtime-token-id",
      requestCount: 17,
      channelId: "C-OLD",
    },
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

describe("integration connection public projection", () => {
  it("redacts structured inline secrets while preserving safe refs, identifiers, and metrics", () => {
    const connection = createConnection();

    const projected = projectIntegrationConnectionForPublicResponse(connection);

    expect(projected).not.toBe(connection);
    expect(projected.config).toEqual({
      botToken: "[REDACTED]",
      webhookUrl: "[REDACTED]",
      callbackUrl: "https://callback.example.test/events?token=[REDACTED]&mode=events",
      callbackPathUrl: "https://callback.example.test/token/[REDACTED]?mode=events",
      headers: {
        Authorization: "[REDACTED]",
        "x-request-id": "request-123",
      },
      DATABASE_PASSWORD: "[REDACTED]",
      botTokenEnv: "SLACK_BOT_TOKEN",
      secretRef: "keychain:slack-bot-token",
      tokenId: "runtime-token-id",
      requestCount: 17,
      channelId: "C-OLD",
    });
    expect(connection.config).toMatchObject({
      botToken: "bot-short",
      webhookUrl: "https://hooks.example.test/services/team?token=hook-short&mode=events",
      callbackPathUrl: "https://callback.example.test/token/path-short?mode=events",
      DATABASE_PASSWORD: "db-short",
      botTokenEnv: "SLACK_BOT_TOKEN",
      secretRef: "keychain:slack-bot-token",
      tokenId: "runtime-token-id",
      requestCount: 17,
    });
  });

  it("restores unchanged redacted and omitted secrets for guided and advanced updates", () => {
    const connection = createConnection();
    const publicConfig = projectIntegrationConnectionForPublicResponse(connection).config;

    const guided = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        ...publicConfig,
        channelId: "C-GUIDED",
      },
    });
    expect(guided.config).toEqual({
      ...connection.config,
      channelId: "C-GUIDED",
    });

    const advanced = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        botTokenEnv: "SLACK_BOT_TOKEN_V2",
        secretRef: "keychain:slack-bot-token",
        tokenId: "runtime-token-id",
        requestCount: 18,
        channelId: "C-ADVANCED",
      },
    });
    expect(advanced.config).toEqual({
      botToken: "bot-short",
      webhookUrl: "https://hooks.example.test/services/team?token=hook-short&mode=events",
      callbackUrl: "https://callback.example.test/events?token=callback-short&mode=events",
      callbackPathUrl: "https://callback.example.test/token/path-short?mode=events",
      headers: {
        Authorization: "Bearer tiny",
      },
      DATABASE_PASSWORD: "db-short",
      botTokenEnv: "SLACK_BOT_TOKEN_V2",
      secretRef: "keychain:slack-bot-token",
      tokenId: "runtime-token-id",
      requestCount: 18,
      channelId: "C-ADVANCED",
    });
    expect(connection.config.channelId).toBe("C-OLD");
  });

  it("accepts explicit replacement or clearing values instead of restoring old secrets", () => {
    const connection = createConnection();
    const publicConfig = projectIntegrationConnectionForPublicResponse(connection).config;

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        ...publicConfig,
        botToken: "",
        webhookUrl: "https://hooks.example.test/services/new?token=replacement-token",
        DATABASE_PASSWORD: null,
        headers: {
          Authorization: "Bearer replacement",
          "x-request-id": "request-456",
        },
      },
    });

    expect(update.config).toMatchObject({
      botToken: "",
      webhookUrl: "https://hooks.example.test/services/new?token=replacement-token",
      DATABASE_PASSWORD: null,
      headers: {
        Authorization: "Bearer replacement",
        "x-request-id": "request-456",
      },
    });
  });

  it("restores same-slot query fragments without discarding adjacent public edits", () => {
    const connection = createConnection();

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        callbackUrl: "https://callback.example.test/events?token=[REDACTED]&mode=alerts",
      },
    });

    expect(update.config).toMatchObject({
      callbackUrl: "https://callback.example.test/events?token=callback-short&mode=alerts",
    });
  });

  it("restores same-slot URL path credentials without discarding adjacent public edits", () => {
    const connection = createConnection();

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        callbackPathUrl: "https://callback.example.test/token/[REDACTED]?mode=alerts",
        channelId: "C-NEXT",
      },
    });

    expect(update.config).toMatchObject({
      callbackPathUrl: "https://callback.example.test/token/path-short?mode=alerts",
      channelId: "C-NEXT",
    });
  });

  it("projects credential-bearing URL paths and text in external-side-effect records", () => {
    const record: ExternalSideEffectRunRecord = {
      runId: "run-1",
      workspaceId: "workspace-1",
      boundary: "integration.write",
      routePath: "/api/v1/integrations/actions",
      actorScope: "operator",
      idempotencyKey: "idem-1",
      payloadHash: "sha256:payload",
      status: "completed",
      replayPolicy: "idempotent",
      resumeState: "completed",
      requestPayload: {
        endpoint: "https://callback.example.test/token/request-short?mode=events",
      },
      errorText: "delivery attempted at https://hooks.slack.com/services/team/bot/signing-short",
      attemptCount: 1,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    };

    const [projected] = projectExternalSideEffectRunsForPublicResponse([record]);

    expect(projected?.requestPayload?.endpoint).toBe("https://callback.example.test/token/[REDACTED]?mode=events");
    expect(projected?.errorText).toBe(
      "delivery attempted at https://hooks.slack.com/services/[REDACTED]/[REDACTED]/[REDACTED]",
    );
    expect(record.requestPayload?.endpoint).toBe("https://callback.example.test/token/request-short?mode=events");
  });

  it("treats webhook URLs as opaque secret leaves and preserves routine marker updates", () => {
    const connection = createConnection();

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        webhookUrl: "[REDACTED]",
      },
    });

    expect(update.config).toMatchObject({
      webhookUrl: "https://hooks.example.test/services/team?token=hook-short&mode=events",
    });
  });

  it("does not transplant an entirely hidden field into a client-supplied marker context", () => {
    const connection = createConnection();

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        botToken: "?token=[REDACTED]&label=changed",
      },
    });

    expect(update.config).toMatchObject({
      botToken: "bot-short",
    });
  });

  it("does not transplant a query credential to another origin", () => {
    const connection = createConnection();

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        callbackUrl: "https://evil.example/?token=[REDACTED]&mode=alerts",
      },
    });

    expect(update.config).toMatchObject({
      callbackUrl: "https://callback.example.test/events?token=callback-short&mode=events",
    });
  });

  it("does not transplant a query credential to another path", () => {
    const connection = createConnection();

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        callbackUrl: "https://callback.example.test/other?token=[REDACTED]&mode=alerts",
      },
    });

    expect(update.config).toMatchObject({
      callbackUrl: "https://callback.example.test/events?token=callback-short&mode=events",
    });
  });

  it("does not transplant a query credential to another query-key slot", () => {
    const connection = createConnection();

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        callbackUrl: "https://callback.example.test/events?apiKey=[REDACTED]&mode=alerts",
      },
    });

    expect(update.config).toMatchObject({
      callbackUrl: "https://callback.example.test/events?token=callback-short&mode=events",
    });
  });

  it("does not transplant a query credential to another occurrence of the same query key", () => {
    const connection = createConnection();

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        callbackUrl: "https://callback.example.test/events?token=public-value&token=[REDACTED]&mode=alerts",
      },
    });

    expect(update.config).toMatchObject({
      callbackUrl: "https://callback.example.test/events?token=callback-short&mode=events",
    });
  });

  it("does not move a recognizable whole secret into a URL marker context", () => {
    const connection = createConnection();
    connection.config.diagnostic = "sk-1234567890abcdef";

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        diagnostic: "https://evil.example/?token=[REDACTED]",
      },
    });

    expect(update.config).toMatchObject({
      diagnostic: "sk-1234567890abcdef",
    });
  });

  it("reconciles secret-bearing object arrays by stable id while preserving edits and deletion", () => {
    const connection = createConnection();
    connection.config.destinations = [
      { id: "one", token: "array-secret-one", label: "One", timeoutMs: 1_000 },
      { id: "two", token: "array-secret-two", label: "Two", timeoutMs: 1_000 },
    ];

    const reordered = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        destinations: [
          { id: "two", token: "[REDACTED]", label: "Two edited", timeoutMs: 2_000 },
          { id: "one", token: "[REDACTED]", label: "One", timeoutMs: 1_000 },
        ],
      },
    });
    const deleted = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        destinations: [{ id: "two", token: "[REDACTED]", label: "Two", timeoutMs: 1_000 }],
      },
    });
    const cleared = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: { destinations: [] },
    });

    expect(reordered.config?.destinations).toEqual([
      { id: "two", token: "array-secret-two", label: "Two edited", timeoutMs: 2_000 },
      { id: "one", token: "array-secret-one", label: "One", timeoutMs: 1_000 },
    ]);
    expect(deleted.config?.destinations).toEqual([
      { id: "two", token: "array-secret-two", label: "Two", timeoutMs: 1_000 },
    ]);
    expect(cleared.config?.destinations).toEqual([]);
    expect(connection.config.destinations).toEqual([
      { id: "one", token: "array-secret-one", label: "One", timeoutMs: 1_000 },
      { id: "two", token: "array-secret-two", label: "Two", timeoutMs: 1_000 },
    ]);
  });

  it("fails closed for marker reordering when object-array identity is absent or ambiguous", () => {
    const connection = createConnection();
    connection.config.destinations = [
      { label: "One", token: "array-secret-one" },
      { label: "Two", token: "array-secret-two" },
    ];

    const reordered = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        destinations: [
          { label: "Two", token: "[REDACTED]" },
          { label: "One", token: "[REDACTED]" },
        ],
      },
    });

    connection.config.destinations = [
      { id: "duplicate", label: "One", token: "array-secret-one" },
      { id: "duplicate", label: "Two", token: "array-secret-two" },
    ];
    const ambiguous = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        destinations: [
          { id: "duplicate", label: "One edited", token: "[REDACTED]" },
          { id: "duplicate", label: "Two", token: "[REDACTED]" },
        ],
      },
    });

    expect(reordered.config?.destinations).toEqual([
      { label: "One", token: "array-secret-one" },
      { label: "Two", token: "array-secret-two" },
    ]);
    expect(ambiguous.config?.destinations).toEqual(connection.config.destinations);
  });

  it("does not assign an existing hidden leaf to a client-supplied stable id", () => {
    const connection = createConnection();
    connection.config.destinations = [
      { id: "one", label: "One", token: "array-secret-one" },
      { id: "two", label: "Two", token: "array-secret-two" },
    ];

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: {
        destinations: [{ id: "three", label: "Three", token: "[REDACTED]" }],
      },
    });

    expect(update.config?.destinations).toEqual(connection.config.destinations);
  });

  it("accepts reordered arrays only when every hidden slot has an explicit non-marker replacement", () => {
    const connection = createConnection();
    connection.config.destinations = [
      { id: "one", token: "array-secret-one", label: "One" },
      { id: "two", token: "array-secret-two", label: "Two" },
    ];
    const replacements = [
      { id: "two", token: "replacement-two", label: "Two" },
      { id: "one", token: "replacement-one", label: "One" },
    ];

    const update = preserveIntegrationConnectionSecretsForPublicUpdate(connection, {
      config: { destinations: replacements },
    });

    expect(update.config?.destinations).toEqual(replacements);
  });
});
