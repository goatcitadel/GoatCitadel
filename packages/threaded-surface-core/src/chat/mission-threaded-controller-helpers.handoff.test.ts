import { describe, expect, it } from "vitest";
import type { AgenticRunTreeResponse } from "@goatcitadel/mission-control-shared/api/agentic";
import {
  agenticBackgroundHandoffTechnicalDetails,
  formatAgenticBackgroundHandoffNotice,
} from "./mission-threaded-controller-helpers";

const RUN_ID = "380d17c7-1111-2222-3333-444455556666";

function tree(overrides: Partial<AgenticRunTreeResponse> = {}): AgenticRunTreeResponse {
  return {
    runId: RUN_ID,
    status: "running",
    nodes: [
      { id: RUN_ID, kind: "run", label: "Demo agentic mission: launch readiness", status: "approval_required" },
      { id: "task-1", kind: "task", label: "Draft", status: "queued" },
    ],
    edges: [],
    diagnostics: [],
    controls: [],
    ...overrides,
  } as unknown as AgenticRunTreeResponse;
}

describe("background handoff notice", () => {
  it("states the approval wait in plain words without the run id", () => {
    const notice = formatAgenticBackgroundHandoffNotice(tree(), null);
    expect(notice).toBe("Demo agentic mission: launch readiness is waiting on your approval, with 1 child task.");
    expect(notice).not.toContain(RUN_ID);
    expect(notice).not.toMatch(/run table|run details|approval required/u);
  });

  it("keeps the run id for technical details only", () => {
    expect(agenticBackgroundHandoffTechnicalDetails(tree())).toEqual([{ label: "Run ID", value: RUN_ID }]);
    expect(agenticBackgroundHandoffTechnicalDetails(null)).toBeUndefined();
  });

  it("follows the run once the approval is settled", () => {
    const settled = tree({
      nodes: [{ id: RUN_ID, kind: "run", label: "Demo agentic mission: launch readiness", status: "running" }],
    } as Partial<AgenticRunTreeResponse>);
    expect(formatAgenticBackgroundHandoffNotice(settled, null)).toBe(
      "Demo agentic mission: launch readiness is running.",
    );
  });
});
