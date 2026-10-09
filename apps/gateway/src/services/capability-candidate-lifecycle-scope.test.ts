import { describe, expect, it, vi } from "vitest";
import type { CandidateSkillDetailRecord, CandidateSkillVersionRecord, CodeModeRunRecord } from "@goatcitadel/contracts";
import { resolveCandidateLifecycleWorkspace } from "./capability-candidate-lifecycle-scope.js";

function fixture(patch: Partial<CandidateSkillVersionRecord> = {}) {
  const version = { candidateId: "candidate", versionId: "version", sourceKind: "workflow_capture", workspaceId: "workspace-capture", ...patch } as CandidateSkillVersionRecord;
  const detail = { candidateId: "candidate", versions: [version], latestVersion: version } as CandidateSkillDetailRecord;
  const readRun = vi.fn<(id: string) => Promise<CodeModeRunRecord>>();
  return { version, detail, readRun, resolve: () => resolveCandidateLifecycleWorkspace(detail, version, readRun) };
}

describe("canonical selected capability lifecycle scope", () => {
  it("uses the workflow version's original scope without fabricating a Code run", async () => {
    const f = fixture();
    expect(await f.resolve()).toBe("workspace-capture");
    expect(f.readRun).not.toHaveBeenCalled();
  });

  it.each(["workspace-capture", undefined])("preserves a Code version with recorded workspace %s and its exact run", async workspaceId => {
    const f = fixture({ sourceKind: "code_mode_generated", workspaceId, originatingRunId: "run" });
    f.detail.originatingRun = { runId: "run", workspaceId: "workspace-capture" } as CodeModeRunRecord;
    expect(await f.resolve()).toBe("workspace-capture");
    expect(f.readRun).not.toHaveBeenCalled();
  });

  it("resolves the older selected version's exact run, rather than the aggregate active origin", async () => {
    const f = fixture({ sourceKind: "code_mode_generated", workspaceId: undefined, originatingRunId: "older-run" });
    f.detail.originatingRun = { runId: "latest-run", workspaceId: "other-workspace" } as CodeModeRunRecord;
    f.readRun.mockResolvedValue({ runId: "older-run", workspaceId: "workspace-capture" } as CodeModeRunRecord);
    expect(await f.resolve()).toBe("workspace-capture");
    expect(f.readRun).toHaveBeenCalledExactlyOnceWith("older-run");
  });

  it("preserves recorded version scope when an older exact run did not record a workspace", async () => {
    const f = fixture({ sourceKind: "code_mode_generated", originatingRunId: "run" });
    f.detail.originatingRun = { runId: "run" } as CodeModeRunRecord;
    expect(await f.resolve()).toBe("workspace-capture");
  });

  it.each([undefined, ""])("refuses unprovable scope %s even if an unrelated aggregate run has one", async workspaceId => {
    const f = fixture({ workspaceId });
    f.detail.originatingRun = { runId: "unrelated", workspaceId: "default" } as CodeModeRunRecord;
    await expect(f.resolve()).rejects.toThrow("no recorded workspace");
    expect(f.readRun).not.toHaveBeenCalled();
  });

  it.each(["aggregate", "read"])("rejects run/version workspace contradiction via %s", async source => {
    const f = fixture({ originatingRunId: "run" });
    const run = { runId: "run", workspaceId: "foreign" } as CodeModeRunRecord;
    if (source === "aggregate") f.detail.originatingRun = run;
    else f.readRun.mockResolvedValue(run);
    await expect(f.resolve()).rejects.toThrow("different workspaces");
  });

  it.each([undefined, { runId: "foreign", workspaceId: "workspace-capture" }])("rejects missing or mismatched run identity %s", async run => {
    const f = fixture({ originatingRunId: "run" });
    f.readRun.mockResolvedValue(run as CodeModeRunRecord);
    await expect(f.resolve()).rejects.toThrow("originating Code Mode run is unavailable or changed");
  });

  it("propagates an unavailable canonical run owner without falling back to the version", async () => {
    const f = fixture({ originatingRunId: "run" });
    f.readRun.mockRejectedValue(new Error("Code Mode run run not found"));
    await expect(f.resolve()).rejects.toThrow("Code Mode run run not found");
  });

  it.each(["candidate", "version", "missing"])("rejects foreign or absent selected %s linkage", async mismatch => {
    const f = fixture();
    const selected = mismatch === "missing" ? undefined : { ...f.version, [mismatch === "candidate" ? "candidateId" : "versionId"]: "foreign" };
    await expect(resolveCandidateLifecycleWorkspace(f.detail, selected, f.readRun)).rejects.toThrow("does not belong");
    expect(f.readRun).not.toHaveBeenCalled();
  });
});
