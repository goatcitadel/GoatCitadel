import { describe, expect, it } from "vitest";
import { __isPermittedIntegrationSecretEnvVarNameForTests as isPermitted } from "./gateway-service.js";

// Regression coverage for CODEX_FINDING #13 + #23: integration connections
// previously accepted arbitrary env-var names in `authTokenEnv` /
// `accessTokenEnv` / `tokenEnv`. A lower-privileged authenticated principal
// could create a productivity.apple-notes connection with
// `authTokenEnv: "OPENAI_API_KEY"` and trigger an action that sent
// `Authorization: Bearer <OPENAI_API_KEY>` to an attacker-controlled URL.

describe("isPermittedIntegrationSecretEnvVarName (codex #13, #23)", () => {
  it("rejects OPENAI_API_KEY and other LLM provider keys", () => {
    expect(isPermitted("OPENAI_API_KEY", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("ANTHROPIC_API_KEY", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("GROQ_API_KEY", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("OPENROUTER_API_KEY", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("FIRECRAWL_API_KEY", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("CLAUDE_CODE_OAUTH_TOKEN", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("GLM_API_KEY", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("MOONSHOT_API_KEY", "productivity.apple-notes")).toBe(false);
  });

  it("rejects gateway/infra secrets", () => {
    expect(isPermitted("GOATCITADEL_AUTH_TOKEN", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("GOATCITADEL_AUTH_BASIC_PASSWORD", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("GOATCITADEL_MESH_JOIN_TOKEN", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("GOATCITADEL_POSTGRES_CONNECTION_STRING", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("POSTGRES_PASSWORD", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("AWS_SECRET_ACCESS_KEY", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("GITHUB_TOKEN", "productivity.apple-notes")).toBe(false);
  });

  it("rejects malformed env-var names", () => {
    expect(isPermitted("", "channel.slack")).toBe(false);
    expect(isPermitted("  ", "channel.slack")).toBe(false);
    expect(isPermitted("path/to/something", "channel.slack")).toBe(false);
    expect(isPermitted("lowercase_only", "channel.slack")).toBe(false);
    expect(isPermitted("HAS SPACE", "channel.slack")).toBe(false);
    expect(isPermitted("X", "channel.slack")).toBe(false); // too short
  });

  it("rejects overlong env-var names", () => {
    expect(isPermitted("A".repeat(200), "channel.slack")).toBe(false);
  });

  it("accepts conventionally-named integration secrets", () => {
    expect(isPermitted("MATRIX_ACCESS_TOKEN", "channel.matrix")).toBe(true);
    expect(isPermitted("APPLE_NOTES_BRIDGE_TOKEN", "productivity.apple-notes")).toBe(true);
    expect(isPermitted("LOCAL_AGENT_AUTH_TOKEN", "productivity.apple-notes")).toBe(true);
    expect(isPermitted("DISCORD_BOT_TOKEN", "channel.discord")).toBe(true);
    expect(isPermitted("SLACK_BOT_TOKEN_V2", "channel.slack")).toBe(true);
    expect(isPermitted("INTEGRATION_MATTERMOST_TOKEN", "channel.mattermost")).toBe(true);
  });

  it("rejects unscoped and cross-catalog integration secret names", () => {
    expect(isPermitted("SLACK_BOT_TOKEN")).toBe(false);
    expect(isPermitted("SLACK_BOT_TOKEN", "productivity.apple-notes")).toBe(false);
    expect(isPermitted("APPLE_NOTES_BRIDGE_TOKEN", "channel.slack")).toBe(false);
    expect(isPermitted("LOCAL_AGENT_DATABASE_PASSWORD", "productivity.apple-notes")).toBe(false);
  });

  it("is case-insensitive on the forbidden list", () => {
    expect(isPermitted("openai_api_key", "channel.slack")).toBe(false); // also pattern-rejected (lowercase)
    expect(isPermitted("OPENAI_API_KEY".toLowerCase(), "channel.slack")).toBe(false);
  });
});
