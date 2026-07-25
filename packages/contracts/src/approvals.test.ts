import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ApprovalEffectKind,
  ApprovalEffectTargetKind,
  ApprovalRequest,
  ShellCommandExplanation,
  ShellExplanationDetail,
  ShellRiskFinding,
  ShellRiskLevel,
} from "./approvals.js";
import {
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND,
} from "./external-sources.js";

describe("ApprovalRequest shellExplanations field", () => {
  it("is an optional readonly array of ShellCommandExplanation", () => {
    expectTypeOf<ApprovalRequest["shellExplanations"]>().toEqualTypeOf<
      readonly ShellCommandExplanation[] | undefined
    >();
  });
});

describe("ShellCommandExplanation", () => {
  it("has required structural fields", () => {
    expectTypeOf<ShellCommandExplanation>().toHaveProperty("command");
    expectTypeOf<ShellCommandExplanation>().toHaveProperty("parsed");
    expectTypeOf<ShellCommandExplanation>().toHaveProperty("summary");
    expectTypeOf<ShellCommandExplanation>().toHaveProperty("details");
    expectTypeOf<ShellCommandExplanation>().toHaveProperty("risks");
    expectTypeOf<ShellCommandExplanation>().toHaveProperty("highestRisk");
  });

  it("highestRisk is a ShellRiskLevel union", () => {
    expectTypeOf<ShellCommandExplanation["highestRisk"]>().toEqualTypeOf<ShellRiskLevel>();
  });
});

describe("external-source knowledge-snapshot effect vocabulary", () => {
  it("admits the dedicated knowledge-snapshot effect kind and import-item target kind", () => {
    expectTypeOf<"external_source_knowledge_snapshot_apply">().toExtend<ApprovalEffectKind>();
    expectTypeOf<"external_source_import_item">().toExtend<ApprovalEffectTargetKind>();
  });

  it("pins the exact frozen effect/target vocabulary constants", () => {
    expect(EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND).toBe("external_source.knowledge_snapshot");
    const effectKind: ApprovalEffectKind = EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND;
    const targetKind: ApprovalEffectTargetKind = EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND;
    expect(effectKind).toBe("external_source_knowledge_snapshot_apply");
    expect(targetKind).toBe("external_source_import_item");
  });
});

describe("governed lifecycle effect vocabulary (HX-402 P0)", () => {
  it("admits the four governed lifecycle effect kinds", () => {
    expectTypeOf<"memory_lifecycle_apply">().toExtend<ApprovalEffectKind>();
    expectTypeOf<"skill_lifecycle_apply">().toExtend<ApprovalEffectKind>();
    expectTypeOf<"capability_lifecycle_apply">().toExtend<ApprovalEffectKind>();
    expectTypeOf<"improvement_lifecycle_apply">().toExtend<ApprovalEffectKind>();
  });

  it("admits the four governed lifecycle effect target kinds", () => {
    expectTypeOf<"memory_record">().toExtend<ApprovalEffectTargetKind>();
    expectTypeOf<"skill_state">().toExtend<ApprovalEffectTargetKind>();
    expectTypeOf<"capability_candidate">().toExtend<ApprovalEffectTargetKind>();
    expectTypeOf<"improvement_operation">().toExtend<ApprovalEffectTargetKind>();
  });
});

describe("ShellRiskFinding + ShellExplanationDetail", () => {
  it("ShellRiskFinding has level + label + explanation", () => {
    expectTypeOf<ShellRiskFinding>().toHaveProperty("level");
    expectTypeOf<ShellRiskFinding>().toHaveProperty("label");
    expectTypeOf<ShellRiskFinding>().toHaveProperty("explanation");
  });

  it("ShellExplanationDetail has label + value with optional note/noteLevel", () => {
    expectTypeOf<ShellExplanationDetail>().toHaveProperty("label");
    expectTypeOf<ShellExplanationDetail>().toHaveProperty("value");
    expectTypeOf<ShellExplanationDetail["note"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ShellExplanationDetail["noteLevel"]>().toEqualTypeOf<ShellRiskLevel | undefined>();
  });
});
