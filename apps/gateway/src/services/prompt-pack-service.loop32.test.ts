import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import {
  buildPromptPackSessionPrefsOverride,
  normalizePromptTestCode,
  parsePromptPackTests,
  resolvePromptPackExecutionProfile,
} from "./prompt-pack-service.js";

describe("prompt-pack service loop32 parsing and runtime prefs", () => {
  it("parses mixed prompt-pack headings while stripping diagnostic metadata from executable prompts", () => {
    const tests = parsePromptPackTests(`
# Chat Tests
## No Tools
- **[TEST-A7] Router posture**
<!-- Prompt Pack Diagnostics:
Capability Targets: routing, routing, \`memory\`
Expected Runtime Signals: tool.retry; fallback.used
Likely Failure Classes: missing_tool, wrong_tool
-->
Answer from local context only.
---
# Cowork Tests
### explicit tools
## 2.04 Research synthesis
Use browser.search and memory.search, then cite the exact evidence.
`);

    expect(tests).toHaveLength(2);
    expect(tests[0]).toMatchObject({
      code: "TEST-A07",
      title: "Router posture",
      mode: "chat",
      toolTier: "no-tools",
      prompt: "Answer from local context only.",
      diagnosticMetadata: {
        capabilityTargets: ["routing", "memory"],
        expectedRuntimeSignals: ["tool.retry", "fallback.used"],
        likelyFailureClasses: ["missing_tool", "wrong_tool"],
      },
    });
    expect(tests[1]).toMatchObject({
      code: "2.4",
      title: "Research synthesis",
      mode: "cowork",
      toolTier: "explicit-tools",
    });
    expect(tests[1]?.prompt).toContain("browser.search");
  });

  it("normalizes prompt codes and derives single-agent runtime prefs from explicit tool directives", () => {
    expect(normalizePromptTestCode("all")).toBe("all");
    expect(normalizePromptTestCode("TEST-b3")).toBe("TEST-B03");
    expect(normalizePromptTestCode("02.004.0005")).toBe("2.4.5");

    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-loop32",
        packId: "pack-loop32",
        code: "TEST-32",
        title: "Loop 32",
        prompt: "Use filesystem.read_file to inspect apps/gateway/src/services/prompt-pack-service.ts.",
        orderIndex: 0,
        mode: "code",
        toolTier: "explicit-tools",
        createdAt: "2026-05-15T00:00:00.000Z",
      },
    });

    expect(buildPromptPackSessionPrefsOverride(profile, "Use filesystem.read_file only.")).toMatchObject({
      mode: "code",
      webMode: "auto",
      memoryMode: "auto",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
    });
  });
});
