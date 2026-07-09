import { describe, expect, it } from "vitest";
import type { HookTrigger } from "./hooks.js";
import type { SkillOutputDocumentDirective } from "./skills.js";

describe("contracts module load smoke", () => {
  it("loads contracts index exports", async () => {
    const mod = await import("./index.js");
    expect(mod).toBeTruthy();
    expect(typeof mod).toBe("object");
  }, // A cold V8-coverage transform of the full contract barrel can exceed the
  // global 5s unit timeout on CI/Windows even though the import itself is sound.
  15_000);

  it("includes gateway.dispatch.before in HookTrigger", () => {
    const trigger: HookTrigger = "gateway.dispatch.before";
    expect(trigger).toBe("gateway.dispatch.before");
  });

  it("includes transform_llm_output in HookTrigger", () => {
    const trigger: HookTrigger = "transform_llm_output";
    expect(trigger).toBe("transform_llm_output");
  });

  it("includes approval.request.before in HookTrigger", () => {
    const trigger: HookTrigger = "approval.request.before";
    expect(trigger).toBe("approval.request.before");
  });

  it("includes approval.response.after in HookTrigger", () => {
    const trigger: HookTrigger = "approval.response.after";
    expect(trigger).toBe("approval.response.after");
  });

  it("exposes SkillOutputDocumentDirective", () => {
    const directive: SkillOutputDocumentDirective = {
      kind: "document",
      fileName: "report.md",
      mimeType: "text/markdown",
      content: "# hello",
    };
    expect(directive.kind).toBe("document");
  });
});
