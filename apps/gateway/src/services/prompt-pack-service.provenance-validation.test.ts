import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import {
  PromptPackService,
  extractPromptPackDiagnosticMetadata,
  extractPromptPackVersionLabel,
  parsePromptPackTests,
  validatePromptPackStructure,
} from "./prompt-pack-service.js";

const PACK_WITH_HEADER = [
  "# GoatCitadel Prompt Pack v7 Overall",
  "",
  "Pack-Version: GoatCitadel Overall v7.0 (2026-07-08)",
  "",
  "Pack size:",
  "- 1 Chat tests",
  "- 1 Cowork tests",
  "",
  "# Chat",
  "",
  "## No Tools",
  "",
  "### TEST-C901: Header fixture",
  "",
  "<!-- Prompt Pack Diagnostics:",
  "Capability Targets: task-success",
  "Expected Runtime Signals: no tool calls",
  "Likely Failure Classes: overlong-answer",
  "Expected Tool Families: none",
  "-->",
  "",
  "Answer briefly. Do not mention Pack-Version: anywhere.",
  "",
  "---",
  "",
  "# Cowork",
  "",
  "## Implicit Tools",
  "",
  "### TEST-W901: Cowork fixture",
  "",
  "<!-- Prompt Pack Diagnostics:",
  "Capability Targets: research",
  "Expected Runtime Signals: uses web if available",
  "Likely Failure Classes: tool-budget-exhausted",
  "Expected Tool Families: Web",
  "-->",
  "",
  "Research something small and synthesize it.",
  "",
].join("\n");

function createImportService(replacePackTests: ReturnType<typeof vi.fn>): PromptPackService {
  const service = new PromptPackService(
    {
      storage: {
        promptPacks: {
          listPacks: () => [],
          replacePackTests,
        },
      },
      config: {
        rootDir: ".",
        assistant: {
          workspaceDir: ".",
          durable: {
            enabled: true,
            executionEnabled: true,
            chatAutoPromoteEnabled: true,
          },
        },
      },
      isFeatureEnabled: () => true,
      requireFeatureEnabled: () => undefined,
      publishRealtime: () => undefined,
    } as never,
    {
      createChatSession: vi.fn(),
      agentSendChatMessage: vi.fn(),
      createChatCompletion: vi.fn(),
      getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      backgroundTasks: new Set(),
    },
  );
  vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);
  return service;
}

function createReplacePackTestsMock() {
  return vi.fn(
    (input: { packId?: string; name: string; sourceLabel?: string; contentSha256?: string; tests: unknown[] }) => ({
      pack: {
        packId: input.packId ?? "pack-import-test",
        name: input.name,
        sourceLabel: input.sourceLabel,
        contentSha256: input.contentSha256,
        testCount: input.tests.length,
        policyHash: "policy-hash",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      },
      tests: [],
    }),
  );
}

describe("prompt-pack version label extraction", () => {
  it("reads Pack-Version from the preamble", () => {
    expect(extractPromptPackVersionLabel(PACK_WITH_HEADER)).toBe("GoatCitadel Overall v7.0 (2026-07-08)");
  });

  it("ignores Pack-Version mentions inside test bodies", () => {
    const withoutHeader = PACK_WITH_HEADER.replace("Pack-Version: GoatCitadel Overall v7.0 (2026-07-08)\n\n", "");
    expect(withoutHeader).toContain("Do not mention Pack-Version:");
    expect(extractPromptPackVersionLabel(withoutHeader)).toBeUndefined();
  });
});

describe("prompt-pack structure validation", () => {
  it("passes when declared counts match parsed counts", () => {
    const tests = parsePromptPackTests(PACK_WITH_HEADER);
    expect(tests).toHaveLength(2);
    expect(validatePromptPackStructure(PACK_WITH_HEADER, tests)).toEqual([]);
  });

  it("reports declared-vs-parsed count mismatches", () => {
    const content = PACK_WITH_HEADER.replace("- 1 Chat tests", "- 3 Chat tests");
    const issues = validatePromptPackStructure(content, parsePromptPackTests(content));
    expect(issues).toEqual(["declared 3 chat tests but parsed 1"]);
  });

  it("validates per-tier declarations when present", () => {
    const content = PACK_WITH_HEADER.replace("- 1 Cowork tests", "- 1 Cowork implicit-tools tests");
    expect(validatePromptPackStructure(content, parsePromptPackTests(content))).toEqual([]);
    const mismatched = PACK_WITH_HEADER.replace("- 1 Cowork tests", "- 2 Cowork explicit-tools tests");
    expect(validatePromptPackStructure(mismatched, parsePromptPackTests(mismatched))).toEqual([
      "declared 2 cowork/explicit-tools tests but parsed 0",
    ]);
  });

  it("reports duplicate test codes", () => {
    const content = PACK_WITH_HEADER.replace("### TEST-W901: Cowork fixture", "### TEST-C901: Duplicate code").replace(
      "- 1 Cowork tests",
      "- 1 Cowork tests".replace("1", "1"),
    );
    const tests = parsePromptPackTests(content);
    const issues = validatePromptPackStructure(content, tests);
    expect(issues.some((issue) => issue.startsWith("duplicate test codes: TEST-C901"))).toBe(true);
  });

  it("reports unknown Expected Tool Families values", () => {
    const content = PACK_WITH_HEADER.replace("Expected Tool Families: Web", "Expected Tool Families: webz");
    const issues = validatePromptPackStructure(content, parsePromptPackTests(content));
    expect(issues).toEqual(["unknown Expected Tool Families values: TEST-W901:webz"]);
  });
});

describe("prompt-pack diagnostics Expected Tool Families key", () => {
  it("parses the fourth key and lowercases values", () => {
    const tests = parsePromptPackTests(PACK_WITH_HEADER);
    expect(tests[0]?.diagnosticMetadata?.expectedToolFamilies).toEqual(["none"]);
    expect(tests[1]?.diagnosticMetadata?.expectedToolFamilies).toEqual(["web"]);
  });

  it("keeps parsing packs without the fourth key", () => {
    const extracted = extractPromptPackDiagnosticMetadata(
      ["<!-- Prompt Pack Diagnostics:", "Capability Targets: web", "-->", "", "Prompt body."].join("\n"),
    );
    expect(extracted.diagnosticMetadata?.capabilityTargets).toEqual(["web"]);
    expect(extracted.diagnosticMetadata?.expectedToolFamilies).toBeUndefined();
  });
});

describe("prompt-pack import provenance", () => {
  it("uses Pack-Version for name and sourceLabel when the caller omits them and stores the content hash", () => {
    const replacePackTests = createReplacePackTestsMock();
    const service = createImportService(replacePackTests);

    service.importPromptPack({ content: PACK_WITH_HEADER });

    expect(replacePackTests).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "GoatCitadel Overall v7.0 (2026-07-08)",
        sourceLabel: "GoatCitadel Overall v7.0 (2026-07-08)",
        contentSha256: createHash("sha256").update(PACK_WITH_HEADER, "utf8").digest("hex"),
      }),
    );
  });

  it("prefers caller-supplied name and sourceLabel over Pack-Version", () => {
    const replacePackTests = createReplacePackTestsMock();
    const service = createImportService(replacePackTests);

    service.importPromptPack({ content: PACK_WITH_HEADER, name: "Named Pack", sourceLabel: "manual-import" });

    expect(replacePackTests).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Named Pack", sourceLabel: "manual-import" }),
    );
  });

  it("rejects imports whose declared counts do not match parsed tests", () => {
    const replacePackTests = createReplacePackTestsMock();
    const service = createImportService(replacePackTests);
    const content = PACK_WITH_HEADER.replace("- 1 Chat tests", "- 3 Chat tests");

    expect(() => service.importPromptPack({ content })).toThrow(
      /Prompt pack structure validation failed: declared 3 chat tests but parsed 1/,
    );
    expect(replacePackTests).not.toHaveBeenCalled();
  });
});
