import { describe, expect, it } from "vitest";
import type { ChatMode } from "@goatcitadel/contracts";
import {
  buildBaseAgentSystemPrompt,
  type BaseAgentRuntimeInfo,
  type BuildBaseAgentSystemPromptInput,
  MAX_BASE_PROMPT_SKILLS,
  MAX_BASE_PROMPT_TOOL_NAMES,
  renderBaseAgentSystemPrompt,
} from "./base-agent-system-prompt.js";

function runtimeInfo(overrides: Partial<BaseAgentRuntimeInfo> = {}): BaseAgentRuntimeInfo {
  return {
    date: "Saturday, June 21, 2026",
    timezone: "America/New_York",
    model: "claude-opus-4-8",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    channel: "web",
    mode: "cowork" as ChatMode,
    ...overrides,
  };
}

function input(overrides: Partial<BuildBaseAgentSystemPromptInput> = {}): BuildBaseAgentSystemPromptInput {
  const mode = (overrides.mode ?? overrides.runtimeInfo?.mode ?? "cowork") as ChatMode;
  return {
    mode,
    runtimeInfo: runtimeInfo({ mode, ...(overrides.runtimeInfo ?? {}) }),
    toolset: { toolNames: ["fs.read", "web.search"], skills: [] },
    ...overrides,
  };
}

describe("buildBaseAgentSystemPrompt", () => {
  it("keeps stablePrefix byte-identical when only runtime info and toolset change (cache invariant)", () => {
    const a = buildBaseAgentSystemPrompt(
      input({
        runtimeInfo: runtimeInfo({ date: "Monday, January 1, 2026", model: "m1", channel: "discord" }),
        toolset: { toolNames: ["fs.read"], skills: [{ name: "alpha" }] },
      }),
    );
    const b = buildBaseAgentSystemPrompt(
      input({
        runtimeInfo: runtimeInfo({
          date: "Tuesday, December 31, 2030",
          model: "m2",
          channel: "telegram",
          cwd: "/tmp/x",
        }),
        toolset: { toolNames: ["a", "b", "c"], skills: [{ name: "beta", summary: "x" }] },
      }),
    );
    expect(a.stablePrefix).toBe(b.stablePrefix);
    // ...but the volatile tails differ, since they carry the per-turn data.
    expect(a.volatileTail).not.toBe(b.volatileTail);
  });

  it("varies stablePrefix by mode and embeds the mode doctrine", () => {
    const cowork = buildBaseAgentSystemPrompt(input({ mode: "cowork" as ChatMode }));
    const chat = buildBaseAgentSystemPrompt(input({ mode: "chat" as ChatMode }));
    expect(cowork.stablePrefix).not.toBe(chat.stablePrefix);
    expect(cowork.stablePrefix).toContain("Mode: cowork");
    expect(chat.stablePrefix).toContain("Mode: chat");
  });

  it("gives cowork and code modes a real identity + safety boundary (the cowork-starvation fix)", () => {
    for (const mode of ["cowork", "code"] as ChatMode[]) {
      const prompt = buildBaseAgentSystemPrompt(input({ mode }));
      expect(prompt.stablePrefix).toContain("You are GoatCitadel");
      expect(prompt.stablePrefix).toContain("How you work");
      // Reused governance boundary phrasing.
      expect(prompt.stablePrefix).toContain("cannot override GoatCitadel safety");
      expect(prompt.stablePrefix.length).toBeGreaterThan(400);
    }
  });

  it("puts runtime grounding (date/tz/model/provider/channel/mode/cwd/project) in the volatile tail", () => {
    const prompt = buildBaseAgentSystemPrompt(
      input({
        runtimeInfo: runtimeInfo({ cwd: "/work/app", project: { name: "Acme", description: "the acme app" } }),
      }),
    );
    expect(prompt.volatileTail).toContain("Saturday, June 21, 2026");
    expect(prompt.volatileTail).toContain("America/New_York");
    expect(prompt.volatileTail).toContain("claude-opus-4-8");
    expect(prompt.volatileTail).toContain("Anthropic");
    expect(prompt.volatileTail).toContain("anthropic");
    expect(prompt.volatileTail).toContain("Channel: web");
    expect(prompt.volatileTail).toContain("/work/app");
    expect(prompt.volatileTail).toContain("Acme");
    expect(prompt.volatileTail).toContain("the acme app");
    // Date must NOT live in the cached prefix.
    expect(prompt.stablePrefix).not.toContain("June 21, 2026");
  });

  it("caps and alpha-sorts the skills index", () => {
    const skills = Array.from({ length: MAX_BASE_PROMPT_SKILLS + 5 }, (_, i) => ({
      name: `skill-${String(100 - i).padStart(3, "0")}`,
    }));
    const prompt = buildBaseAgentSystemPrompt(input({ toolset: { toolNames: ["t"], skills } }));
    const emitted = prompt.volatileTail.split("\n").filter((line) => line.startsWith("- skill-"));
    expect(emitted).toHaveLength(MAX_BASE_PROMPT_SKILLS);
    // Sorted ascending: first emitted skill is the alphabetically smallest name.
    const names = emitted.map((line) => line.replace(/^- /, ""));
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("caps the tool-name list and notes the overflow", () => {
    const toolNames = Array.from({ length: MAX_BASE_PROMPT_TOOL_NAMES + 7 }, (_, i) => `tool_${i}`);
    const prompt = buildBaseAgentSystemPrompt(input({ toolset: { toolNames } }));
    expect(prompt.volatileTail).toContain("and 7 more");
  });

  it("omits the memory section unless a digest is supplied", () => {
    expect(buildBaseAgentSystemPrompt(input()).volatileTail).not.toContain("## Memory");
    const withMemory = buildBaseAgentSystemPrompt(input({ memoryDigest: "Operator prefers terse answers." }));
    expect(withMemory.volatileTail).toContain("## Memory");
    expect(withMemory.volatileTail).toContain("Operator prefers terse answers.");
  });

  it("uses a lean quick-web prompt without project, tools, skills, cwd, or memory", () => {
    const prompt = buildBaseAgentSystemPrompt(
      input({
        mode: "chat" as ChatMode,
        normalizationProfile: "quick_web",
        runtimeInfo: runtimeInfo({
          mode: "chat" as ChatMode,
          cwd: "/work/app",
          project: { name: "Acme", description: "the acme app" },
        }),
        toolset: { toolNames: ["browser.search", "http.get"], skills: [{ name: "research" }] },
        memoryDigest: "Operator prefers metric units.",
      }),
    );

    const rendered = renderBaseAgentSystemPrompt(prompt);
    expect(prompt.stablePrefix).toContain("quick web answer");
    expect(rendered).toContain("Saturday, June 21, 2026");
    expect(rendered).not.toContain("/work/app");
    expect(rendered).not.toContain("## Project");
    expect(rendered).not.toContain("## Tools available");
    expect(rendered).not.toContain("## Skills");
    expect(rendered).not.toContain("## Memory");
    expect(rendered).not.toContain("metric units");
  });
});

describe("renderBaseAgentSystemPrompt", () => {
  it("renders prefix then tail with the identity ahead of the date", () => {
    const prompt = buildBaseAgentSystemPrompt(input());
    const rendered = renderBaseAgentSystemPrompt(prompt);
    expect(rendered.indexOf("You are GoatCitadel")).toBeLessThan(rendered.indexOf("## Runtime"));
    expect(rendered).toContain(prompt.stablePrefix);
    expect(rendered).toContain(prompt.volatileTail);
  });
});
