import { describe, expect, it } from "vitest";
import type { ChatMode } from "@goatcitadel/contracts";
import {
  buildBaseAgentSystemPrompt,
  DEEP_RESEARCH_PROMPT_SECTION,
  type BaseAgentRuntimeInfo,
  type BuildBaseAgentSystemPromptInput,
  MAX_BASE_PROMPT_SKILLS,
  MAX_BASE_PROMPT_TOOL_NAMES,
  renderBaseAgentSystemPromptBlocks,
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

  it("keeps capability creation inside the current conversation instead of asking for mode switches", () => {
    const prompt = buildBaseAgentSystemPrompt(input({ mode: "chat" as ChatMode }));
    expect(prompt.stablePrefix).toContain("Do not ask the operator to switch Chat, Cowork, or Code modes");
    expect(prompt.stablePrefix).toContain("Do not tell the operator to paste/apply work in Code Mode");
  });

  it("requires grounded location and candidate-level evidence for local rankings", () => {
    const prompt = buildBaseAgentSystemPrompt(input({ mode: "chat" as ChatMode }));
    expect(prompt.stablePrefix).toContain("use a city or ZIP code supplied by the operator");
    expect(prompt.stablePrefix).toContain("Search snippets alone do not establish a ranking");
    const quickWeb = buildBaseAgentSystemPrompt(input({ mode: "chat" as ChatMode, normalizationProfile: "quick_web" }));
    expect(quickWeb.stablePrefix).toContain("label search-snippet-only results unverified");
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

  it("lists no tools or skills and says tools are off when this turn cannot call tools", () => {
    // A catalog of tools the turn cannot call makes models write the calls out as text instead.
    const prompt = buildBaseAgentSystemPrompt(
      input({
        toolsUnavailableReason: "manual_autonomy",
        toolset: { toolNames: ["fs.read", "web.search"], skills: [{ name: "pdf-generator", summary: "Make PDFs" }] },
      }),
    );
    expect(prompt.volatileTail).not.toContain("## Tool catalog");
    expect(prompt.volatileTail).not.toContain("fs.read");
    expect(prompt.volatileTail).not.toContain("## Skills you can draw on");
    expect(prompt.volatileTail).toContain("## Tools");
    expect(prompt.volatileTail).toContain("No tools can be called in this turn");
    expect(prompt.volatileTail).toContain("Do not write tool calls");
    expect(prompt.volatileTail).toContain("Safe Auto");
    // The cached prefix stays byte-identical, so turning tools off never busts the prompt cache.
    expect(prompt.stablePrefix).toBe(buildBaseAgentSystemPrompt(input()).stablePrefix);
  });

  it("keeps the tool catalog when the turn can call tools", () => {
    const prompt = buildBaseAgentSystemPrompt(input({ toolsUnavailableReason: undefined }));
    expect(prompt.volatileTail).toContain("## Tool catalog (current policy still applies)\nfs.read, web.search");
    expect(prompt.volatileTail).not.toContain("No tools can be called in this turn");
  });

  it("says every tool asks for approval first when the policy probe found that (#502)", () => {
    // The safe profile asks before every action; the model used to guess "based on risk, not confirmed policy".
    const tail = buildBaseAgentSystemPrompt(
      input({
        toolset: { toolNames: ["fs.read", "web.search"], approvalRequiredToolNames: ["fs.read", "web.search"] },
      }),
    ).volatileTail;
    expect(tail).toContain("## Tool catalog (current policy still applies)\nfs.read, web.search");
    expect(tail).toContain("Approval: every tool listed here asks the operator for approval before it runs.");
    expect(tail).toMatch(/a specific call can still be blocked or need approval because of its arguments/i);
  });

  it("names the tools that ask first, and says the rest run without asking, when only some need approval", () => {
    const tail = buildBaseAgentSystemPrompt(
      input({
        toolset: { toolNames: ["fs.read", "web.search", "time.now"], approvalRequiredToolNames: ["web.search"] },
      }),
    ).volatileTail;
    expect(tail).toContain("Approval: these ask the operator for approval before they run: web.search.");
    expect(tail).toContain("The other listed tools run without asking.");
  });

  it("says none need approval when the probe found none, and says nothing when approval is unknown", () => {
    const none = buildBaseAgentSystemPrompt(
      input({ toolset: { toolNames: ["fs.read", "web.search"], approvalRequiredToolNames: [] } }),
    ).volatileTail;
    expect(none).toContain("Approval: none of the listed tools asks for approval");
    // A toolset without a policy probe (no turn scope) must not claim anything about approval.
    const unknown = buildBaseAgentSystemPrompt(input()).volatileTail;
    expect(unknown).not.toContain("Approval:");
  });

  it("tells the model to decline write-and-run plainly and names the real switch when policy denies writes and shell (#494)", () => {
    const tail = buildBaseAgentSystemPrompt(
      input({
        toolset: {
          toolNames: ["fs.read", "documents.create", "tests.run", "change.request"],
          policyDeniedToolNames: ["fs.write", "fs.patch", "shell.exec"],
        },
      }),
    ).volatileTail;
    expect(tail).toContain("## Writing and running code");
    expect(tail).toContain("cannot create or change code files or run scripts");
    expect(tail).toContain("Settings › Tools › Global filesystem tool access");
    expect(tail).toContain("change.request");
    expect(tail).toContain("tool policy file");
    expect(tail).toMatch(/do not save code through document tools/i);
    expect(tail).toMatch(/test, lint or build tool/i);
  });

  it("only offers change.request when it is callable, and only names the shell switch when shell is denied", () => {
    const tail = buildBaseAgentSystemPrompt(
      input({ toolset: { toolNames: ["fs.read"], policyDeniedToolNames: ["fs.write"] } }),
    ).volatileTail;
    expect(tail).toContain("Settings › Tools › Global filesystem tool access");
    expect(tail).not.toContain("change.request");
    expect(tail).not.toContain("tool policy file");
  });

  it("leaves the write-and-run note out when writes and shell are allowed, or when no tools can be called", () => {
    const allowed = buildBaseAgentSystemPrompt(
      input({ toolset: { toolNames: ["fs.write", "shell.exec"], policyDeniedToolNames: ["browser.cookies.get"] } }),
    ).volatileTail;
    expect(allowed).not.toContain("## Writing and running code");
    const manual = buildBaseAgentSystemPrompt(
      input({
        toolsUnavailableReason: "manual_autonomy",
        toolset: { toolNames: [], policyDeniedToolNames: ["fs.write", "shell.exec"] },
      }),
    ).volatileTail;
    expect(manual).not.toContain("## Writing and running code");
  });

  it("names what actually turns tools off, and only suggests Safe Auto when that is the fix", () => {
    const tail = (toolsUnavailableReason: BuildBaseAgentSystemPromptInput["toolsUnavailableReason"]) =>
      buildBaseAgentSystemPrompt(input({ toolsUnavailableReason })).volatileTail;
    expect(tail("manual_autonomy")).toContain("tool autonomy is Manual");
    for (const [reason, cause] of [
      ["advisory_planning", "advisory planning"],
      ["capability_profile", "capability profile"],
      ["project_binding_required", "bound to a project"],
    ] as const) {
      expect(tail(reason)).toContain("No tools can be called in this turn");
      expect(tail(reason)).toContain(cause);
      expect(tail(reason)).not.toContain("Safe Auto");
    }
  });

  it("replaces the Deep research contract with an honest no-research note when tools are off", () => {
    const prompt = buildBaseAgentSystemPrompt(input({ webMode: "deep", toolsUnavailableReason: "manual_autonomy" }));
    expect(prompt.volatileTail).not.toContain(DEEP_RESEARCH_PROMPT_SECTION);
    expect(prompt.volatileTail).toContain("could not research");
    expect(prompt.volatileTail).toContain("unverified");
    // With tools available, Deep mode keeps its full contract.
    expect(buildBaseAgentSystemPrompt(input({ webMode: "deep" })).volatileTail).toContain(DEEP_RESEARCH_PROMPT_SECTION);
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

  it("adds the Deep research contract to the volatile tail only, leaving the cached prefix unchanged", () => {
    const deep = buildBaseAgentSystemPrompt(input({ mode: "chat" as ChatMode, webMode: "deep" }));
    const auto = buildBaseAgentSystemPrompt(input({ mode: "chat" as ChatMode, webMode: "auto" }));
    expect(DEEP_RESEARCH_PROMPT_SECTION).toBe(
      [
        "## Web research: deep",
        "The operator turned on Deep research for this message.",
        "When this message needs information from the web:",
        "- Run 2–4 differently worded searches before answering; do not stop at the first result page.",
        "- Open at least two relevant pages from different sites before relying on them, preferring primary sources.",
        "- Cross-check key facts across sources and say which claims you could not verify.",
        "- Cite the pages you relied on by URL.",
        "Skip web research for greetings and for questions about local files or this workspace.",
      ].join("\n"),
    );
    expect(deep.volatileTail).toContain(DEEP_RESEARCH_PROMPT_SECTION);
    expect(deep.stablePrefix).toBe(auto.stablePrefix);
    expect(deep.stablePrefix).not.toContain("## Web research: deep");
    expect(auto.volatileTail).not.toContain("## Web research: deep");
    for (const webMode of ["off", "quick"] as const) {
      const other = buildBaseAgentSystemPrompt(input({ mode: "chat" as ChatMode, webMode }));
      expect(other.volatileTail).not.toContain("## Web research: deep");
    }
  });

  it("never adds the Deep research contract to the quick-web prompt", () => {
    const prompt = buildBaseAgentSystemPrompt(
      input({ mode: "chat" as ChatMode, normalizationProfile: "quick_web", webMode: "deep" }),
    );
    expect(renderBaseAgentSystemPrompt(prompt)).not.toContain("## Web research: deep");
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

describe("renderBaseAgentSystemPromptBlocks", () => {
  it("renders the stable prefix before the volatile tail as separate system blocks", () => {
    const prompt = buildBaseAgentSystemPrompt(input());
    const blocks = renderBaseAgentSystemPromptBlocks(prompt);
    expect(blocks).toEqual([
      { type: "text", text: prompt.stablePrefix },
      { type: "text", text: prompt.volatileTail },
    ]);
    expect(blocks[0]?.text).toContain("You are GoatCitadel");
    expect(blocks[0]?.text).not.toContain("Saturday, June 21, 2026");
    expect(blocks[1]?.text).toContain("Saturday, June 21, 2026");
  });

  it("omits an empty volatile tail without changing the stable block", () => {
    const blocks = renderBaseAgentSystemPromptBlocks({ stablePrefix: "stable", volatileTail: "   " });
    expect(blocks).toEqual([{ type: "text", text: "stable" }]);
  });
});
