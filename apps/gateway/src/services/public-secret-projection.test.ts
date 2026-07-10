import { describe, expect, it } from "vitest";
import { projectPublicErrorValue, projectPublicSecretValue } from "./public-secret-projection.js";

describe("public secret projection", () => {
  it("redacts structured credentials and common credential-bearing URL paths without mutating input", () => {
    const raw = {
      provider: {
        authorization: "Bearer short",
        tokenId: "safe-token-id",
        requestCount: 7,
      },
      pairingCode: "ABC123",
      messages: [
        "Discord https://discord.com/api/webhooks/123456/discord-secret-token failed.",
        "Slack https://hooks.slack.com/services/T000/B000/slack-secret-token failed.",
        "Telegram https://api.telegram.org/bot123456:telegram-secret/getMe failed.",
        "Generic https://provider.example.test/%2574oken/generic-secret?%74oken=query-secret failed.",
      ],
    };

    expect(projectPublicSecretValue(raw)).toEqual({
      provider: {
        authorization: "[REDACTED]",
        tokenId: "safe-token-id",
        requestCount: 7,
      },
      pairingCode: "ABC123",
      messages: [
        "Discord https://discord.com/api/webhooks/[REDACTED]/[REDACTED] failed.",
        "Slack https://hooks.slack.com/services/[REDACTED]/[REDACTED]/[REDACTED] failed.",
        "Telegram https://api.telegram.org/bot[REDACTED]/getMe failed.",
        "Generic https://provider.example.test/%2574oken/[REDACTED]?%74oken=[REDACTED] failed.",
      ],
    });
    expect(raw.provider.authorization).toBe("Bearer short");
    expect(raw.messages[0]).toContain("discord-secret-token");
    expect(raw.messages[1]).toContain("slack-secret-token");
    expect(raw.messages[2]).toContain("telegram-secret");
  });

  it("projects error payloads without collapsing validation arrays for credential-named fields", () => {
    const raw = {
      error: "Provider failed with Authorization: Bearer public-error-secret",
      details: {
        webhookUrl: "https://hooks.slack.com/services/T000/B000/public-path-secret",
        DATABASE_PASSWORD: "tiny-error-secret",
        tokenId: "safe-error-token-id",
      },
      validation: {
        fieldErrors: {
          token: ["Required", "short-secret-value"],
          webhookUrl: ["Must be a valid URL"],
        },
      },
    };

    const projected = projectPublicErrorValue(raw);

    expect(projected).toEqual({
      error: "Provider failed with Authorization: [REDACTED]",
      details: {
        webhookUrl: "[REDACTED]",
        DATABASE_PASSWORD: "[REDACTED]",
        tokenId: "safe-error-token-id",
      },
      validation: {
        fieldErrors: {
          token: ["Required", "[REDACTED]"],
          webhookUrl: ["Must be a valid URL"],
        },
      },
    });
    expect(raw.error).toContain("public-error-secret");
    expect(raw.details.webhookUrl).toContain("public-path-secret");
  });
});
