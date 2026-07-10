import { describe, expect, it } from "vitest";
import type { ChatGeneratedArtifactRecord, ChatMessageRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import {
  preserveChatSessionSecretsForPublicUpdate,
  projectChatGeneratedArtifactForPublic,
  projectChatMessageForPublic,
  projectChatSessionForPublic,
} from "./chat-secret-projection.js";

describe("chat secret projection", () => {
  it("projects legacy generated-artifact content without changing canonical content or hash truth", () => {
    const artifact: ChatGeneratedArtifactRecord = {
      artifactId: "artifact-1",
      sessionId: "session-1",
      turnId: "turn-1",
      title: "password: legacy-title-secret",
      kind: "markdown",
      content:
        '{\\"DATABASE_PASSWORD\\":\\"legacy-content-secret\\",\\"webhookUrl\\":\\"https://hooks.example.test/services/team/legacy-hook-secret\\"}',
      sourceSurface: "chat",
      version: 1,
      contentHash: "sha256:stored-content",
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
    };

    const projected = projectChatGeneratedArtifactForPublic(artifact);

    expect(JSON.stringify(projected)).not.toContain("legacy-title-secret");
    expect(JSON.stringify(projected)).not.toContain("legacy-content-secret");
    expect(JSON.stringify(projected)).not.toContain("legacy-hook-secret");
    expect(projected.contentHash).toBe("sha256:stored-content");
    expect(projected.publicProjection).toEqual(
      expect.objectContaining({
        contentRedacted: true,
        canonicalContentHashRefersToStoredArtifact: true,
      }),
    );
    expect(artifact.title).toContain("legacy-title-secret");
    expect(artifact.content).toContain("legacy-content-secret");
  });

  it("does not claim content was redacted when only generated-artifact metadata changed", () => {
    const artifact: ChatGeneratedArtifactRecord = {
      artifactId: "artifact-title-only",
      sessionId: "session-1",
      turnId: "turn-1",
      title: "password: legacy-title-secret",
      kind: "markdown",
      content: "credential-free content",
      sourceSurface: "chat",
      version: 1,
      contentHash: "sha256:stored-content",
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
    };

    const projected = projectChatGeneratedArtifactForPublic(artifact);

    expect(projected.publicProjection).toMatchObject({
      artifactRedacted: true,
      contentRedacted: false,
      redactionCount: 1,
    });
  });

  it("projects generated-artifact reference metadata nested in public session records", () => {
    const session = {
      sessionId: "session-reference",
      sessionKey: "mission:operator:reference",
      scope: "mission",
      includeInHistory: true,
      pinned: false,
      lifecycleStatus: "active",
      channel: "mission",
      account: "operator",
      updatedAt: "2026-07-09T12:00:00.000Z",
      lastActivityAt: "2026-07-09T12:00:00.000Z",
      tokenTotal: 0,
      costUsdTotal: 0,
      generatedArtifacts: [
        {
          artifactId: "artifact-reference",
          kind: "markdown",
          title: "Authorization: Bearer nested-reference-secret",
          sourceSurface: "chat",
          version: 1,
          createdAt: "2026-07-09T12:00:00.000Z",
        },
      ],
    } satisfies ChatSessionRecord;

    const projected = projectChatSessionForPublic(session);

    expect(JSON.stringify(projected)).not.toContain("nested-reference-secret");
    expect(projected.tokenTotal).toBe(0);
    expect(session.generatedArtifacts?.[0]?.title).toContain("nested-reference-secret");
  });

  it("restores every canonical credential-label slot while preserving safe title edits", () => {
    const labels = [
      "auth",
      "authentication",
      "authorization",
      "proxyAuthorization",
      "bearer",
      "cookie",
      "cookies",
      "credential",
      "credentials",
      "apiKey",
      "apikey",
      "clientKey",
      "accessKey",
      "privateKey",
      "consumerKey",
      "signingKey",
      "accessToken",
      "refreshToken",
      "clientSecret",
      "token",
      "secret",
      "password",
      "passwd",
      "signature",
      "webhookUrl",
      "webhookUri",
      "webhookEndpoint",
      "databasePassword",
    ] as const;

    for (const label of labels) {
      const session = {
        sessionId: `session-${label}`,
        sessionKey: `mission:operator:${label}`,
        scope: "mission",
        includeInHistory: true,
        pinned: false,
        lifecycleStatus: "active",
        channel: "mission",
        account: "operator",
        title: `original ${label}=sk-abcdefghijklmnop note`,
        updatedAt: "2026-07-09T12:00:00.000Z",
        lastActivityAt: "2026-07-09T12:00:00.000Z",
        tokenTotal: 0,
        costUsdTotal: 0,
      } satisfies ChatSessionRecord;
      const projected = projectChatSessionForPublic(session);

      expect(projected.title, label).toBe(`original ${label}=[REDACTED] note`);
      expect(
        preserveChatSessionSecretsForPublicUpdate(session, {
          title: `renamed ${label}=[REDACTED] note`,
        }),
        label,
      ).toEqual({ title: `renamed ${label}=sk-abcdefghijklmnop note` });
      expect(session.title, label).toBe(`original ${label}=sk-abcdefghijklmnop note`);
    }
  });

  it("keeps assistant code valid while removing literal credentials", () => {
    const message: ChatMessageRecord = {
      messageId: "message-code",
      sessionId: "session-code",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: [
        "type Login = { password: string };",
        "const password = process.env.PASSWORD;",
        "const apiKey = process.env.API_KEY;",
        'const denoApiKey = Deno.env.get("API_KEY");',
        'const pythonApiKey = os.getenv("API_KEY");',
        'const accessorApiKey = secrets.get("API_KEY");',
        'const awaitedApiKey = await secrets.get("API_KEY");',
        "apiKey=${API_KEY}",
        "const password = config.password;",
        "type GenericLogin = { password: SomeType<string> };",
        "const passwordPolicy: PasswordPolicy = strict;",
        'const apiKey = "literal-chat-secret";',
        "const templatePassword = `hello world`;",
        'const header = "Authorization: Custom one two three";',
        "const templateHeader = `Authorization: Token abcdef1234567890`;",
      ].join("\n"),
      timestamp: "2026-07-09T12:00:00.000Z",
    };

    const projected = projectChatMessageForPublic(message);

    expect(projected?.content).toBe(
      [
        "type Login = { password: string };",
        "const password = process.env.PASSWORD;",
        "const apiKey = process.env.API_KEY;",
        'const denoApiKey = Deno.env.get("API_KEY");',
        'const pythonApiKey = os.getenv("API_KEY");',
        'const accessorApiKey = secrets.get("API_KEY");',
        'const awaitedApiKey = await secrets.get("API_KEY");',
        "apiKey=${API_KEY}",
        "const password = config.password;",
        "type GenericLogin = { password: SomeType<string> };",
        "const passwordPolicy: PasswordPolicy = strict;",
        'const apiKey = "[REDACTED]";',
        "const templatePassword = `[REDACTED]`;",
        'const header = "Authorization: [REDACTED]";',
        "const templateHeader = `Authorization: [REDACTED]`;",
      ].join("\n"),
    );
    expect(message.content).toContain('"literal-chat-secret"');
  });

  it("contains arbitrary authorization values in ordinary JSON message content", () => {
    const message: ChatMessageRecord = {
      messageId: "message-json-auth",
      sessionId: "session-code",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: '{"authorization":"Custom one two three"}',
      timestamp: "2026-07-09T12:00:00.000Z",
    };

    expect(projectChatMessageForPublic(message)?.content).toBe('{"authorization":"[REDACTED]"}');
    expect(message.content).toContain("Custom one two three");
  });
});
