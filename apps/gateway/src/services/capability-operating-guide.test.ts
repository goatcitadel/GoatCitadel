import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "@goatcitadel/policy-engine";
import {
  CAPABILITY_GUIDE_OVERVIEW,
  CAPABILITY_GUIDE_SECTIONS,
  getCapabilityGuide,
} from "./capability-operating-guide.js";
import { buildBaseAgentSystemPrompt, type BuildBaseAgentSystemPromptInput } from "./base-agent-system-prompt.js";

function prompt(overrides: Partial<BuildBaseAgentSystemPromptInput> = {}) {
  return buildBaseAgentSystemPrompt({
    mode: "chat",
    runtimeInfo: {
      date: "November 18, 2026",
      timezone: "America/Los_Angeles",
      providerId: "test",
      model: "test",
      channel: "web",
      mode: "chat",
    },
    toolset: { toolNames: ["capabilities.explain"] },
    ...overrides,
  });
}

describe("capability operating guide", () => {
  it("flags removed or renamed built-in tools mentioned in guide prose", () => {
    const registry = createDefaultToolRegistry();
    const guideProse = [
      CAPABILITY_GUIDE_OVERVIEW,
      ...CAPABILITY_GUIDE_SECTIONS.flatMap(({ title, workflow, limitations }) => [title, workflow, limitations]),
    ].join("\n");
    const names = [...new Set([...guideProse.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]!))];
    expect(names.length).toBeGreaterThan(0);
    expect(
      names.filter((name) => !registry.get(name)),
      "Operating guide tool references must match the current built-in registry.",
    ).toEqual([]);
  });

  it.each([
    ["email", "connectors"],
    ["run code", "code"],
    ["remember", "memory"],
    ["reminder", "automation"],
    ["research", "research"],
    ["pdf", "files"],
    ["blocked", "setup"],
  ])("retrieves workflow guidance for %s", (query, id) => {
    expect(getCapabilityGuide(query!).sections).toContainEqual(
      expect.objectContaining({ id, workflow: expect.any(String), limitations: expect.any(String) }),
    );
  });
  it("keeps the overview compact and details bounded, with honest execution limits", () => {
    const guide = getCapabilityGuide("research files email code schedule memory setup");
    expect(guide.overview.length).toBeLessThan(1000);
    expect(guide.sections).toHaveLength(3);
    expect(getCapabilityGuide("code").sections[0]!.limitations).toContain("not hostile-code sandboxing");
    expect(guide.overview).toContain("No catalog, guide, or explanation grants permission");
  });
  it("injects the compact guide independently of operator guidance and teaches live explanation when callable", () => {
    expect(prompt().stablePrefix).toContain("## Operating guide");
    expect(prompt().volatileTail).toContain("call capabilities.explain");
  });
  it("does not instruct tool-less or quick-web turns to call the explainer", () => {
    expect(prompt({ toolsUnavailableReason: "manual_autonomy" }).volatileTail).not.toContain(
      "call capabilities.explain",
    );
    expect(prompt({ toolset: { toolNames: [] } }).volatileTail).not.toContain("call capabilities.explain");
    const quick = prompt({ normalizationProfile: "quick_web" });
    expect(quick.stablePrefix).not.toContain("## Operating guide");
    expect(quick.volatileTail).not.toContain("capabilities.explain");
  });
});
