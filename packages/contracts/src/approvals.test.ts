import { describe, expectTypeOf, it } from "vitest";
import type {
  ApprovalRequest,
  ShellCommandExplanation,
  ShellExplanationDetail,
  ShellRiskFinding,
  ShellRiskLevel,
} from "./approvals.js";

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
