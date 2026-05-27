import { describe, expect, it, vi } from "vitest";
import { SkillsRouteService, type SkillsRoutePort } from "./skills-route-service.js";

describe("SkillsRouteService", () => {
  it("delegates every route operation to the skills port with original arguments", async () => {
    const port = fakePort();
    const service = new SkillsRouteService(port);

    const calls: Array<[keyof SkillsRoutePort, () => unknown | Promise<unknown>, unknown[]]> = [
      ["listSkills", () => service.listSkills(), []],
      ["reloadSkills", () => service.reloadSkills(), []],
      ["listSkillExportTargets", () => service.listSkillExportTargets(), []],
      [
        "previewSkillExport",
        () => service.previewSkillExport({ skillIds: ["skill-1"], target: "codex" }),
        [{ skillIds: ["skill-1"], target: "codex" }],
      ],
      [
        "packageSkillExport",
        () => service.packageSkillExport({ skillIds: ["skill-1"], target: "generic-markdown" }),
        [{ skillIds: ["skill-1"], target: "generic-markdown" }],
      ],
      ["listSkillSources", () => service.listSkillSources("query", 5), ["query", 5]],
      [
        "lookupSkillSources",
        () => service.lookupSkillSources("https://example.test/skill", 6),
        ["https://example.test/skill", 6],
      ],
      [
        "validateSkillImport",
        () => service.validateSkillImport({ sourceRef: "skill-ref" }),
        [{ sourceRef: "skill-ref" }],
      ],
      [
        "installSkillImport",
        () => service.installSkillImport({ sourceRef: "skill-ref", force: true }),
        [{ sourceRef: "skill-ref", force: true }],
      ],
      ["listSkillImportHistory", () => service.listSkillImportHistory(7), [7]],
      [
        "previewSkillEvaluation",
        () => service.previewSkillEvaluation("skill-1", { prompt: "check" } as never),
        ["skill-1", { prompt: "check" }],
      ],
      [
        "runSkillEvaluation",
        () => service.runSkillEvaluation("skill-2", { prompt: "run" } as never),
        ["skill-2", { prompt: "run" }],
      ],
      ["listSkillEvaluationRuns", () => service.listSkillEvaluationRuns("skill-3"), ["skill-3"]],
      ["getSkillEvaluationRun", () => service.getSkillEvaluationRun("run-1"), ["run-1"]],
      ["createSkillEvaluationProposal", () => service.createSkillEvaluationProposal("run-2"), ["run-2"]],
      [
        "resolveSkillActivation",
        () => service.resolveSkillActivation({ skillId: "skill-4" } as never),
        [{ skillId: "skill-4" }],
      ],
      ["setSkillState", () => service.setSkillState("skill-5", "enabled", "ready"), ["skill-5", "enabled", "ready"]],
      [
        "bulkSetSkillState",
        () => service.bulkSetSkillState(["skill-6", "skill-7"], "sleep", "quiet"),
        [["skill-6", "skill-7"], "sleep", "quiet"],
      ],
      ["getSkillActivationPolicy", () => service.getSkillActivationPolicy(), []],
      [
        "updateSkillActivationPolicy",
        () => service.updateSkillActivationPolicy({ guardedAutoThreshold: 0.8 } as never),
        [{ guardedAutoThreshold: 0.8 }],
      ],
    ];

    for (const [method, invoke, args] of calls) {
      await expect(Promise.resolve(invoke())).resolves.toEqual({ method });
      expect(port[method]).toHaveBeenCalledWith(...args);
    }
  });

  it("passes optional omitted arguments through as undefined", () => {
    const port = fakePort();
    const service = new SkillsRouteService(port);

    service.listSkillSources();
    service.listSkillImportHistory();

    expect(port.listSkillSources).toHaveBeenCalledWith(undefined, undefined);
    expect(port.listSkillImportHistory).toHaveBeenCalledWith(undefined);
  });
});

function fakePort(): SkillsRoutePort {
  const methods = [
    "bulkSetSkillState",
    "getSkillActivationPolicy",
    "installSkillImport",
    "listSkillImportHistory",
    "listSkillEvaluationRuns",
    "listSkillExportTargets",
    "listSkillSources",
    "listSkills",
    "lookupSkillSources",
    "previewSkillEvaluation",
    "previewSkillExport",
    "packageSkillExport",
    "runSkillEvaluation",
    "getSkillEvaluationRun",
    "createSkillEvaluationProposal",
    "reloadSkills",
    "resolveSkillActivation",
    "setSkillState",
    "updateSkillActivationPolicy",
    "validateSkillImport",
  ] as const;
  const port: Partial<Record<(typeof methods)[number], ReturnType<typeof vi.fn>>> = {};
  for (const method of methods) {
    port[method] = vi.fn(() => ({ method }));
  }
  return port as unknown as SkillsRoutePort;
}
