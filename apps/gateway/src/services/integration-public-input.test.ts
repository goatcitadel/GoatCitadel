import { describe, expect, it } from "vitest";
import { assertIntegrationPublicInput } from "./integration-public-input.js";
describe("integration public input boundary", () => {
  it.each([
    { botToken: "disposable-value" },
    { nested: { password: "disposable-value" } },
    { webhookUrl: "https://discord.com/api/webhooks/fixture/disposable-value" },
    { bridgeUrl: "https://bridge.invalid/?token=disposable-value" },
    { tokenEnv: "not a variable name" },
  ])("rejects secret material before ordinary configuration persistence", (config) => {
    expect(() => assertIntegrationPublicInput("productivity.github", config)).toThrow();
  });
  it("allows masked unchanged credentials and supported public fields", () => {
    expect(() =>
      assertIntegrationPublicInput("productivity.github", {
        token: "[REDACTED]",
        repo: "fixture/project",
        tokenEnv: "GITHUB_TOKEN",
      }, { token: "synthetic-existing", repo: "fixture/project", tokenEnv: "GITHUB_TOKEN" }),
    ).not.toThrow();
  });
  it.each(["[REDACTED]", "[redacted]", "%5BREDACTED%5D"])("never accepts an invented marker %s", marker => {
    expect(() => assertIntegrationPublicInput("automation.webhooks", { baseUrl: `https://public.invalid/${marker}` })).toThrow();
    expect(() => assertIntegrationPublicInput("channel.slack", { botToken: marker })).toThrow();
  });
  it("allows unchanged nested masked leaves, but rejects moving or editing a credential URL mask", () => {
    const current = { nested: { password: "synthetic-existing", label: "before" }, bridgeUrl: "https://bridge.invalid/?token=synthetic-existing" };
    expect(() => assertIntegrationPublicInput("channel.slack", { nested: { password: "[REDACTED]", label: "after" } }, current)).not.toThrow();
    expect(() => assertIntegrationPublicInput("channel.slack", { other: { password: "[REDACTED]" } }, current)).toThrow();
    expect(() => assertIntegrationPublicInput("channel.slack", { bridgeUrl: "https://other.invalid/?token=[REDACTED]" }, current)).toThrow();
  });
});
