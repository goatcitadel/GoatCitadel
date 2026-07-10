import { describe, expect, it } from "vitest";
import { redactSecretText, redactStructuredSecrets } from "./secret-redaction.js";

describe("redactSecretText", () => {
  it("redacts common provider, channel, and authorization secrets", () => {
    const result = redactSecretText(
      [
        "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz",
        "1234567890:AAH0123456789012345678901234567890abc",
        "ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
        "AKIAIOSFODNN7EXAMPLE",
        "Authorization: Bearer abc123def456ghi789jkl",
      ].join(" "),
    );

    expect(result.value).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] Authorization: [REDACTED]");
    expect(result.redactionCount).toBe(5);
  });

  it("preserves useful key and query structure while redacting values", () => {
    const result = redactSecretText(
      'api-key="abcDEF123._~+/" token: qwerty1234 https://example.test/hook?token=secret-token&ok=1',
    );

    expect(result.value).toBe("api-key=[REDACTED] token: [REDACTED] https://example.test/hook?token=[REDACTED]&ok=1");
    expect(result.redactionCount).toBe(3);
  });

  it("redacts literal env values without redacting short or whitespace values", () => {
    const result = redactSecretText("custom=fcrl_abcdefghijklmnop short=abc spaced=two words", {
      env: {
        FIRECRAWL_API_KEY: "fcrl_abcdefghijklmnop",
        SHORT: "abc",
        SPACED: "two words",
      },
    });

    expect(result.value).toBe("custom=[REDACTED_ENV:FIRECRAWL_API_KEY] short=abc spaced=two words");
    expect(result.redactionCount).toBe(1);
  });

  it("redacts short values when an explicit credential key labels serialized text", () => {
    const result = redactSecretText('{"DATABASE_PASSWORD":"Tr0ub4dor&3","password":"p@ssw0rd!","visible":"ok"}');

    expect(result.value).toBe('{"DATABASE_PASSWORD":[REDACTED],"password":[REDACTED],"visible":"ok"}');
    expect(result.redactionCount).toBe(2);

    const assignments = redactSecretText("DATABASE_PASSWORD=Tr0ub4dor&3 password: p@ssw0rd!");
    expect(assignments.value).toBe("DATABASE_PASSWORD=[REDACTED] password: [REDACTED]");
    expect(assignments.redactionCount).toBe(2);

    const escaped = redactSecretText('{\\"DATABASE_PASSWORD\\":\\"tiny\\",\\"visible\\":\\"ok\\"}');
    expect(escaped.value).toBe('{\\"DATABASE_PASSWORD\\":\\"[REDACTED]\\",\\"visible\\":\\"ok\\"}');
    expect(escaped.redactionCount).toBe(1);
  });

  it("preserves non-secret code expressions while redacting literal credential assignments", () => {
    const result = redactSecretText(
      [
        "const tokenBudget = 1000;",
        "const tokenCount = 5;",
        "const passwordPolicy = true;",
        "const accessToken = getToken();",
        'const apiKey = "literal-secret";',
        "password=hunter2",
        "password=1234",
      ].join("\n"),
    );

    expect(result.value).toBe(
      [
        "const tokenBudget = 1000;",
        "const tokenCount = 5;",
        "const passwordPolicy = true;",
        "const accessToken = getToken();",
        "const apiKey = [REDACTED];",
        "password=[REDACTED]",
        "password=[REDACTED]",
      ].join("\n"),
    );
    expect(result.redactionCount).toBe(3);
  });

  it("redacts remote approval capability tokens inside callback data and free text", () => {
    const token = `grat_${"a".repeat(43)}`;
    const result = redactSecretText(`callback=gca:${token}:a raw=${token}`);

    expect(result.value).toBe("callback=gca:[REDACTED]:a raw=[REDACTED]");
    expect(result.redactionCount).toBe(2);
    expect(
      redactStructuredSecrets({
        callbackData: `gca:${token}:r`,
        note: `Use ${token} once`,
        tokenId: "remote-action-token-id",
      }).value,
    ).toEqual({
      callbackData: "gca:[REDACTED]:r",
      note: "Use [REDACTED] once",
      tokenId: "remote-action-token-id",
    });
  });

  it("does not reinterpret repeated authorization labels as credential values", () => {
    const result = redactSecretText(`${"Authorization: ".repeat(128)}Bearer abcDEF-._~+/== done`);

    expect(result.value).toContain("Authorization: [REDACTED] done");
    expect(result.value).not.toContain("abcDEF");
    expect(result.redactionCount).toBe(1);
  });

  it("preserves channel address schemes while still redacting URL userinfo", () => {
    const result = redactSecretText(
      "imessage:group@example.com whatsapp:15551234567@s.whatsapp.net https://user:pass@example.com/path",
    );

    expect(result.value).toBe(
      "imessage:group@example.com whatsapp:15551234567@s.whatsapp.net https://[REDACTED]@example.com/path",
    );
    expect(result.redactionCount).toBe(1);
  });

  it("redacts credential-bearing channel URL paths while preserving ordinary URLs", () => {
    const result = redactSecretText(
      [
        "failure https://hooks.slack.com/services/T000/B000/abc12345",
        "discord https://discord.com/api/webhooks/123456/discord-short",
        "telegram https://api.telegram.org/bot123456:telegram-short/sendMessage",
        "safe https://example.test/docs/token/setup",
      ].join("; "),
    );

    expect(result.value).toBe(
      [
        "failure https://hooks.slack.com/services/[REDACTED]/[REDACTED]/[REDACTED]",
        "discord https://discord.com/api/webhooks/[REDACTED]/[REDACTED]",
        "telegram https://api.telegram.org/bot[REDACTED]/sendMessage",
        "safe https://example.test/docs/token/setup",
      ].join("; "),
    );
    expect(result.redactionCount).toBe(3);
  });
});

describe("redactStructuredSecrets", () => {
  it("redacts sensitive keys and secret-bearing string leaves without mutating safe references or metrics", () => {
    const input = {
      webhookUrl: "https://example.test/hook?token=short-token",
      authorization: "Bearer short",
      DATABASE_PASSWORD: "tiny-secret",
      tokenEnv: "WEBHOOK_TOKEN",
      secretRef: "keychain:webhook-token",
      tokenBudget: 4_096,
      tokenId: "runtime-token-identifier-123456",
      refreshTokenHandle: "gmail-primary",
      tokenInput: 11,
      tokenOutput: 7,
      tokenCachedInput: 3,
      tokenTotal: 18,
      timeToFirstToken: 125,
      sessionTokenHardCap: 100_000,
      accessTokenExpiresAt: "2026-07-09T12:00:00.000Z",
      tokenRefreshSkewSeconds: 30,
    };

    const result = redactStructuredSecrets(input);

    expect(result.value).toEqual({
      webhookUrl: "[REDACTED]",
      authorization: "[REDACTED]",
      DATABASE_PASSWORD: "[REDACTED]",
      tokenEnv: "WEBHOOK_TOKEN",
      secretRef: "keychain:webhook-token",
      tokenBudget: 4_096,
      tokenId: "runtime-token-identifier-123456",
      refreshTokenHandle: "gmail-primary",
      tokenInput: 11,
      tokenOutput: 7,
      tokenCachedInput: 3,
      tokenTotal: 18,
      timeToFirstToken: 125,
      sessionTokenHardCap: 100_000,
      accessTokenExpiresAt: "2026-07-09T12:00:00.000Z",
      tokenRefreshSkewSeconds: 30,
    });
    expect(result.redactionCount).toBe(3);
    expect(result.redactedPaths).toEqual(["$.webhookUrl", "$.authorization", "$.DATABASE_PASSWORD"]);
    expect(result.redactions).toEqual([
      { path: "$.webhookUrl", reason: "sensitive_key" },
      { path: "$.authorization", reason: "sensitive_key" },
      { path: "$.DATABASE_PASSWORD", reason: "sensitive_key" },
    ]);
    expect(input).toEqual({
      webhookUrl: "https://example.test/hook?token=short-token",
      authorization: "Bearer short",
      DATABASE_PASSWORD: "tiny-secret",
      tokenEnv: "WEBHOOK_TOKEN",
      secretRef: "keychain:webhook-token",
      tokenBudget: 4_096,
      tokenId: "runtime-token-identifier-123456",
      refreshTokenHandle: "gmail-primary",
      tokenInput: 11,
      tokenOutput: 7,
      tokenCachedInput: 3,
      tokenTotal: 18,
      timeToFirstToken: 125,
      sessionTokenHardCap: 100_000,
      accessTokenExpiresAt: "2026-07-09T12:00:00.000Z",
      tokenRefreshSkewSeconds: 30,
    });
  });

  it("reports and safely projects circular references", () => {
    const input: Record<string, unknown> = { visible: "ok" };
    input.self = input;

    const result = redactStructuredSecrets(input);

    expect(result.value).toEqual({ visible: "ok", self: "[Circular]" });
    expect(result.redactionCount).toBe(1);
    expect(result.redactedPaths).toEqual(["$.self"]);
    expect(result.redactions).toEqual([{ path: "$.self", reason: "circular_reference" }]);
    expect(input.self).toBe(input);
  });

  it("collapses a whole bearer credential leaf while preserving structure around embedded secrets", () => {
    expect(redactStructuredSecrets("Bearer abcdefghijklmnopqrstuvwxyz").value).toBe("[REDACTED]");
    expect(redactStructuredSecrets("result: Bearer abcdefghijklmnopqrstuvwxyz").value).toBe(
      "result: Bearer [REDACTED]",
    );
  });

  it("preserves explicitly typed binary payloads without exempting signatures or untyped high-entropy text", () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    expect(
      redactStructuredSecrets({
        bytesBase64: pngBase64,
        dataBase64: pngBase64,
        b64Json: pngBase64,
        signatureBase64: pngBase64,
        opaque: pngBase64,
      }).value,
    ).toEqual({
      bytesBase64: pngBase64,
      dataBase64: pngBase64,
      b64Json: pngBase64,
      signatureBase64: "[REDACTED]",
      opaque: "[REDACTED]",
    });
  });

  it("contains short auth aliases without hiding non-secret auth metadata", () => {
    expect(
      redactStructuredSecrets({
        auth: "tiny",
        authContext: "operator",
        authenticationMode: "oauth",
      }).value,
    ).toEqual({
      auth: "[REDACTED]",
      authContext: "operator",
      authenticationMode: "oauth",
    });
  });

  it("preserves boolean credential-readiness metadata without trusting string lookalikes", () => {
    expect(
      redactStructuredSecrets({
        hasApiKey: true,
        hasKeychainSecret: false,
        requiresGatewayAuth: true,
        hasSecret: true,
        unsafe: { hasApiKey: "tiny-unlabelled-value" },
      }).value,
    ).toEqual({
      hasApiKey: true,
      hasKeychainSecret: false,
      requiresGatewayAuth: true,
      hasSecret: true,
      unsafe: { hasApiKey: "[REDACTED]" },
    });
  });

  it("does not let credential values bypass redaction through safe metadata keys", () => {
    expect(
      redactStructuredSecrets({
        tokenEnv: "Bearer short",
        secretRef: "https://example.test/hook?token=short-token",
        tokenId: "sk-1234567890abcdefghijklmnop",
        tokenBudget: "tiny-secret",
      }).value,
    ).toEqual({
      tokenEnv: "[REDACTED]",
      secretRef: "[REDACTED]",
      tokenId: "[REDACTED]",
      tokenBudget: "[REDACTED]",
    });
  });

  it("rejects credential syntax hidden in typed IDs, references, and cursors without mutating input", () => {
    const input = {
      secretRef: "password=hunter2",
      tokenId: "api_key=tiny-secret",
      sourceRef: "Authorization: Basic dXNlcjpwYXNz",
      cursor: "password=cursor-secret",
      safeSecretRef: "keychain:webhook-token",
      runId: "run-secret-projection",
      artifactRef: "artifact-token-proof",
      nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
    };
    const original = structuredClone(input);

    const result = redactStructuredSecrets(input);

    expect(result.value).toEqual({
      secretRef: "[REDACTED]",
      tokenId: "[REDACTED]",
      sourceRef: "Authorization: [REDACTED]",
      cursor: "password=[REDACTED]",
      safeSecretRef: "keychain:webhook-token",
      runId: "run-secret-projection",
      artifactRef: "artifact-token-proof",
      nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
    });
    expect(result.redactionCount).toBe(4);
    expect(result.redactions).toEqual([
      { path: "$.secretRef", reason: "sensitive_key" },
      { path: "$.tokenId", reason: "sensitive_key" },
      { path: "$.sourceRef", reason: "secret_text" },
      { path: "$.cursor", reason: "secret_text" },
    ]);
    expect(input).toEqual(original);
  });

  it("contains path-carried webhook credentials while preserving credential-free OAuth metadata", () => {
    expect(
      redactStructuredSecrets({
        webhookUrl: "https://hooks.slack.com/services/T000/B000/shortsecret",
        authorizationUrl: "https://identity.example.test/oauth/authorize",
        tokenUrl: "https://identity.example.test/oauth/token",
        tokenEndpoint: "https://identity.example.test/oauth/token",
        authHeaderName: "X-Workspace-Authorization",
        authActorId: "operator-1",
        authActorSource: "loopback",
      }).value,
    ).toEqual({
      webhookUrl: "[REDACTED]",
      authorizationUrl: "https://identity.example.test/oauth/authorize",
      tokenUrl: "https://identity.example.test/oauth/token",
      tokenEndpoint: "https://identity.example.test/oauth/token",
      authHeaderName: "X-Workspace-Authorization",
      authActorId: "operator-1",
      authActorSource: "loopback",
    });
  });

  it("preserves typed identifiers and target keys even when their labels contain secret-shaped words", () => {
    expect(
      redactStructuredSecrets({
        runId: "run-secret-projection",
        approvalId: "approval-token-projection",
        artifactId: "artifact-secret-projection",
        operatorProfileId: "operator-secret-profile",
        targetKey: "target-secret-projection",
      }).value,
    ).toEqual({
      runId: "run-secret-projection",
      approvalId: "approval-token-projection",
      artifactId: "artifact-secret-projection",
      operatorProfileId: "operator-secret-profile",
      targetKey: "target-secret-projection",
    });
  });

  it("preserves shipped readiness, OAuth, and credential metadata without preserving nested credentials", () => {
    expect(
      redactStructuredSecrets({
        apiKeyReady: true,
        supportsRotateSecret: true,
        resolvesSecrets: true,
        persistSecretToSecureStore: false,
        apiKeySource: "keychain",
        authReadiness: "ready",
        authMethods: ["oauth", "bot_token"],
        authRequirements: ["device_identity", "short_lived_access_token"],
        authStatusCodes: [401, 403],
        authProfile: {
          accountRef: "meet-account-1",
          available: true,
          source: "oauth_thread",
        },
        authState: {
          authType: "oauth2",
          readiness: "ready",
          accessTokenRef: "keychain:mcp-access",
          refreshTokenRef: "keychain:mcp-refresh",
          tokenExpiresAt: "2026-07-09T12:00:00.000Z",
          scopes: ["repo:read"],
          error: "Authorization: Bearer nested-secret",
        },
        secretReadiness: {
          required: ["OPENAI_API_KEY"],
          configured: ["OPENAI_API_KEY"],
          missing: [],
        },
        secretFieldKeys: ["botToken", "clientSecret"],
        redactedSecretCount: 2,
        fencingToken: 7,
        credentialStorage: "partial",
        credentialFileChecks: [
          { pathLabel: "Codex auth file", exists: true, permissionStatus: "ok", note: "Metadata only" },
        ],
        peerCredentials: [
          {
            peerId: "peer-1",
            label: "Build peer",
            status: "configured",
            scopes: ["tasks:read"],
            checkedAt: "2026-07-09T12:00:00.000Z",
          },
        ],
        signatureAlgorithm: "ed25519",
        signatureStatus: "signed_hmac",
      }).value,
    ).toEqual({
      apiKeyReady: true,
      supportsRotateSecret: true,
      resolvesSecrets: true,
      persistSecretToSecureStore: false,
      apiKeySource: "keychain",
      authReadiness: "ready",
      authMethods: ["oauth", "bot_token"],
      authRequirements: ["device_identity", "short_lived_access_token"],
      authStatusCodes: [401, 403],
      authProfile: {
        accountRef: "meet-account-1",
        available: true,
        source: "oauth_thread",
      },
      authState: {
        authType: "oauth2",
        readiness: "ready",
        accessTokenRef: "keychain:mcp-access",
        refreshTokenRef: "keychain:mcp-refresh",
        tokenExpiresAt: "2026-07-09T12:00:00.000Z",
        scopes: ["repo:read"],
        error: "Authorization: [REDACTED]",
      },
      secretReadiness: {
        required: ["OPENAI_API_KEY"],
        configured: ["OPENAI_API_KEY"],
        missing: [],
      },
      secretFieldKeys: ["botToken", "clientSecret"],
      redactedSecretCount: 2,
      fencingToken: 7,
      credentialStorage: "partial",
      credentialFileChecks: [
        { pathLabel: "Codex auth file", exists: true, permissionStatus: "ok", note: "Metadata only" },
      ],
      peerCredentials: [
        {
          peerId: "peer-1",
          label: "Build peer",
          status: "configured",
          scopes: ["tasks:read"],
          checkedAt: "2026-07-09T12:00:00.000Z",
        },
      ],
      signatureAlgorithm: "ed25519",
      signatureStatus: "signed_hmac",
    });
  });

  it("preserves validated public auth containers and readiness records while projecting their leaves", () => {
    const runtimeAuth = {
      mode: "token",
      allowLoopbackBypass: false,
      tokenConfigured: true,
      basicConfigured: false,
      plan: {
        mode: "token",
        warnings: ["Authorization: Bearer nested-plan-secret"],
        token: { configured: true, source: "env" },
        basicUsername: { configured: false, source: "none" },
        basicPassword: { configured: false, source: "none" },
      },
    };

    expect(
      redactStructuredSecrets({
        runtime: { auth: runtimeAuth },
        connector: {
          auth: [{ id: "oauth", type: "oauth2", name: "OAuth", managed: true }],
        },
        followOn: {
          authReadiness: [
            {
              key: "short_lived_access_token",
              label: "Short-lived access token",
              state: "have_foundation",
              note: "Implemented",
            },
          ],
        },
        toolPolicy: {
          authContext: {
            boundary: "gateway_only",
            secretRefs: ["keychain:provider-token"],
          },
        },
        tokenEstimates: { system: 10, history: 20, total: 30 },
      }).value,
    ).toEqual({
      runtime: {
        auth: {
          ...runtimeAuth,
          plan: {
            ...runtimeAuth.plan,
            warnings: ["Authorization: [REDACTED]"],
          },
        },
      },
      connector: {
        auth: [{ id: "oauth", type: "oauth2", name: "OAuth", managed: true }],
      },
      followOn: {
        authReadiness: [
          {
            key: "short_lived_access_token",
            label: "Short-lived access token",
            state: "have_foundation",
            note: "Implemented",
          },
        ],
      },
      toolPolicy: {
        authContext: {
          boundary: "gateway_only",
          secretRefs: ["keychain:provider-token"],
        },
      },
      tokenEstimates: { system: 10, history: 20, total: 30 },
    });
  });

  it("preserves safe-shaped public previews, hashes, references, cursors, and blinded labels", () => {
    const tokenHash = "a".repeat(64);
    const requestSecretHash = "b".repeat(64);

    expect(
      redactStructuredSecrets({
        auth: { scheme: "bearer", tokenPreview: "noti...oken" },
        shortTokenPreview: "***",
        tokenHash,
        requestSecretHash,
        sourceRef: "memory://source-token-projection",
        artifactRefs: ["artifact-token-proof", "artifact-secret-proof"],
        cursor: "2026-07-09T12:00:00.000Z|session-token-projection",
        nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
        blindedAuthorToken: "proposal-1",
        blindedReviewerToken: "blind:anthropic:claude-sonnet-5",
      }).value,
    ).toEqual({
      auth: { scheme: "bearer", tokenPreview: "noti...oken" },
      shortTokenPreview: "***",
      tokenHash,
      requestSecretHash,
      sourceRef: "memory://source-token-projection",
      artifactRefs: ["artifact-token-proof", "artifact-secret-proof"],
      cursor: "2026-07-09T12:00:00.000Z|session-token-projection",
      nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
      blindedAuthorToken: "proposal-1",
      blindedReviewerToken: "blind:anthropic:claude-sonnet-5",
    });
  });

  it("keeps browser cookie summaries while containing raw plural cookie values", () => {
    expect(
      redactStructuredSecrets({
        summary: { cookies: { count: 2, domains: ["example.test", "docs.example.test"] } },
        rawArray: { cookies: [{ name: "session", value: "tiny" }] },
        rawObject: { cookies: { session: "tiny" } },
        rawString: { cookies: "tiny" },
      }).value,
    ).toEqual({
      summary: { cookies: { count: 2, domains: ["example.test", "docs.example.test"] } },
      rawArray: { cookies: "[REDACTED]" },
      rawObject: { cookies: "[REDACTED]" },
      rawString: { cookies: "[REDACTED]" },
    });
  });

  it("fails closed for metadata lookalikes, malformed safe-key values, and actual credential fields", () => {
    const approvalCapabilityToken = `grat_${"a".repeat(43)}`;
    const telegramBotToken = `1234567890:${"b".repeat(35)}`;
    const result = redactStructuredSecrets({
      apiKeyReady: "true",
      apiKeySource: "inline-but-secret",
      authReadiness: "Bearer raw-readiness",
      auth: { type: "query", value: "tiny" },
      tokenPreview: "raw-token-value",
      tokenHash: "not-a-cryptographic-digest",
      requestSecretHash: "tiny",
      fencingToken: "7",
      blindedAuthorToken: "raw-token-value",
      blindedReviewerToken: "Bearer raw-reviewer",
      cursor: "https://example.test/page?token=raw-cursor",
      sourceRef: "https://example.test/page?access_token=raw-source",
      runId: approvalCapabilityToken,
      artifactRef: telegramBotToken,
      nextCursor: approvalCapabilityToken,
      tokenEnv: { value: "tiny" },
      secretRef: { value: "tiny" },
      unsafeSecretRef: "tiny secret",
      refreshTokenHandle: "tiny handle",
      tokenId: ["tiny"],
      peerCredentials: [{ peerId: "peer-1", token: "tiny" }],
      apiKey: "tiny",
      accessToken: "tiny",
      refreshToken: "tiny",
      token: "tiny",
      clientSecret: "tiny",
      password: "tiny",
      signature: "tiny",
      signatureBase64: "tiny",
      deviceToken: "tiny",
      botToken: "tiny",
    }).value;

    expect(result).toEqual({
      apiKeyReady: "[REDACTED]",
      apiKeySource: "[REDACTED]",
      authReadiness: "[REDACTED]",
      auth: "[REDACTED]",
      tokenPreview: "[REDACTED]",
      tokenHash: "[REDACTED]",
      requestSecretHash: "[REDACTED]",
      fencingToken: "[REDACTED]",
      blindedAuthorToken: "[REDACTED]",
      blindedReviewerToken: "[REDACTED]",
      cursor: "https://example.test/page?token=[REDACTED]",
      sourceRef: "https://example.test/page?access_token=[REDACTED]",
      runId: "[REDACTED]",
      artifactRef: "[REDACTED]",
      nextCursor: "[REDACTED]",
      tokenEnv: "[REDACTED]",
      secretRef: "[REDACTED]",
      unsafeSecretRef: "[REDACTED]",
      refreshTokenHandle: "[REDACTED]",
      tokenId: "[REDACTED]",
      peerCredentials: "[REDACTED]",
      apiKey: "[REDACTED]",
      accessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      token: "[REDACTED]",
      clientSecret: "[REDACTED]",
      password: "[REDACTED]",
      signature: "[REDACTED]",
      signatureBase64: "[REDACTED]",
      deviceToken: "[REDACTED]",
      botToken: "[REDACTED]",
    });
  });
});
