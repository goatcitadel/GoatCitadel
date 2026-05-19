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
    expect(isPermitted("OPENAI_API_KEY")).toBe(false);
    expect(isPermitted("ANTHROPIC_API_KEY")).toBe(false);
    expect(isPermitted("GROQ_API_KEY")).toBe(false);
    expect(isPermitted("OPENROUTER_API_KEY")).toBe(false);
    expect(isPermitted("FIRECRAWL_API_KEY")).toBe(false);
  });

  it("rejects gateway/infra secrets", () => {
    expect(isPermitted("GOATCITADEL_AUTH_TOKEN")).toBe(false);
    expect(isPermitted("GOATCITADEL_POSTGRES_PASSWORD")).toBe(false);
    expect(isPermitted("AWS_SECRET_ACCESS_KEY")).toBe(false);
    expect(isPermitted("GITHUB_TOKEN")).toBe(false);
  });

  it("rejects malformed env-var names", () => {
    expect(isPermitted("")).toBe(false);
    expect(isPermitted("  ")).toBe(false);
    expect(isPermitted("path/to/something")).toBe(false);
    expect(isPermitted("lowercase_only")).toBe(false);
    expect(isPermitted("HAS SPACE")).toBe(false);
    expect(isPermitted("X")).toBe(false); // too short
  });

  it("rejects overlong env-var names", () => {
    expect(isPermitted("A".repeat(200))).toBe(false);
  });

  it("accepts conventionally-named integration secrets", () => {
    expect(isPermitted("MATRIX_ACCESS_TOKEN")).toBe(true);
    expect(isPermitted("APPLE_NOTES_BRIDGE_TOKEN")).toBe(true);
    expect(isPermitted("DISCORD_BOT_TOKEN")).toBe(true);
    expect(isPermitted("INTEGRATION_MATTERMOST_TOKEN")).toBe(true);
  });

  it("is case-insensitive on the forbidden list", () => {
    expect(isPermitted("openai_api_key")).toBe(false); // also pattern-rejected (lowercase)
    expect(isPermitted("OPENAI_API_KEY".toLowerCase())).toBe(false);
  });
});
