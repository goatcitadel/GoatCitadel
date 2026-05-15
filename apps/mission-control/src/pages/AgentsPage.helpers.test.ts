import { describe, expect, it } from "vitest";
import {
  buildFormChanges,
  buildPresetDefaultsFromForm,
  emptyForm,
  formFromAgent,
  hasAdvancedPresetDefaults,
  normalizeRoleIdCandidate,
  splitMultiline,
} from "./agents/agents-page-helpers";

describe("AgentsPage helper behavior", () => {
  it("hydrates the editor form from agent records with optional preset defaults", () => {
    expect(
      formFromAgent({
        roleId: "coder",
        name: "Coder",
        title: "Implementation Engineer",
        summary: "Writes patches",
        specialties: ["typescript", "tests"],
        defaultTools: ["shell", "apply_patch"],
        aliases: ["dev"],
        presetDefaults: {
          presetLabel: "Patch mode",
          presetSummary: "Focused code work",
          routeHint: "code",
          preferredProviderId: "openai",
          preferredModel: "gpt-5.4",
          toolsPosture: "manual",
          knowledgeAttachmentIds: ["repo"],
          promptFraming: "Be surgical.",
        },
      } as any),
    ).toMatchObject({
      roleId: "coder",
      specialtiesText: "typescript\ntests",
      defaultToolsText: "shell\napply_patch",
      aliasesText: "dev",
      presetRouteHint: "code",
      presetKnowledgeAttachmentsText: "repo",
    });

    expect(
      formFromAgent({
        roleId: "qa",
        name: "QA",
        title: "Verification Lead",
        summary: "Tests behavior",
        specialties: [],
        defaultTools: [],
        aliases: [],
      } as any).presetLabel,
    ).toBe("");
  });

  it("splits multiline values and normalizes role ids for persistence", () => {
    expect(splitMultiline(" shell \n\nshell\r\napply_patch ")).toEqual(["shell", "apply_patch"]);
    expect(normalizeRoleIdCandidate("  Coder / QA ++ Runtime!  ")).toBe("coder-qa-runtime");
    expect(normalizeRoleIdCandidate("!!!")).toBe("");
    expect(normalizeRoleIdCandidate("x".repeat(120))).toHaveLength(80);
  });

  it("builds preset defaults only when the form carries preset data", () => {
    const blank = emptyForm();
    expect(hasAdvancedPresetDefaults(blank)).toBe(false);
    expect(buildPresetDefaultsFromForm(blank)).toBeUndefined();

    const form = {
      ...blank,
      presetLabel: "Pair reviewer",
      presetSummary: "Review-focused",
      presetRouteHint: "code" as const,
      presetProviderId: "openai",
      presetModel: "gpt-5.4",
      presetToolsPosture: "safe_auto" as const,
      presetKnowledgeAttachmentsText: "repo\npolicy\nrepo",
      presetPromptFraming: "Find regressions.",
    };

    expect(hasAdvancedPresetDefaults(form)).toBe(true);
    expect(buildPresetDefaultsFromForm(form)).toEqual({
      presetLabel: "Pair reviewer",
      presetSummary: "Review-focused",
      routeHint: "code",
      preferredProviderId: "openai",
      preferredModel: "gpt-5.4",
      toolsPosture: "safe_auto",
      knowledgeAttachmentIds: ["repo", "policy"],
      promptFraming: "Find regressions.",
    });

    expect(hasAdvancedPresetDefaults({ ...blank, presetPromptFraming: "Use the local repo first." })).toBe(true);
    expect(buildPresetDefaultsFromForm({ ...blank, presetPromptFraming: "Use the local repo first." })).toEqual({
      promptFraming: "Use the local repo first.",
    });
    expect(buildPresetDefaultsFromForm({ ...blank, presetLabel: "Label only" })).toEqual({
      presetLabel: "Label only",
    });
  });

  it("reports changed form fields with API-facing labels", () => {
    const baseline = emptyForm();
    const current = {
      ...baseline,
      name: "Coder",
      specialtiesText: "typescript",
      presetModel: "gpt-5.4",
    };

    expect(buildFormChanges(current, baseline)).toEqual([
      { field: "name", from: "", to: "Coder" },
      { field: "specialties", from: "", to: "typescript" },
      { field: "preferredModel", from: "", to: "gpt-5.4" },
    ]);
  });
});
