// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import type { ObserveRunTraceResponse } from "@goatcitadel/mission-control-shared/api/durable";
import { RunLineage } from "./RunLineage";

const api = vi.hoisted(() => ({ fetchDurableBackgroundTaskRail: vi.fn(), controlDurableBackgroundTask: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => api);

const now = "2026-09-30T00:00:00.000Z";
function trace(): ObserveRunTraceResponse {
  return {
    version: "observe.run_trace.v1", generatedAt: now, runId: "parent-run",
    run: { runId: "parent-run", workflowKey: "chat.turn.execute", status: "completed", version: 1,
      attemptCount: 1, maxAttempts: 3, createdAt: now, updatedAt: now,
      payload: { workspaceId: "workspace-a", sessionId: "session-a" } },
    lifecycle: { state: "available", response: {
      query: { runId: "parent-run" }, canonical: { runId: "parent-run", sessionId: "session-a" },
      linked: { sessionIds: ["session-a"], turnIds: [], runIds: ["parent-run"], proactiveRunIds: [], approvalIds: [], taskIds: [], workspaceIds: ["workspace-a"] },
      turns: [], toolRuns: [],
    } },
    session: { state: "not_available" }, thread: { state: "not_available", turns: [] },
    durable: { checkpoints: { state: "not_available", items: [] }, timeline: { state: "not_available", items: [] } },
    approvals: { state: "not_available", items: [], missingIds: [] }, toolCalls: { state: "not_available", items: [] },
    memoryContext: { state: "not_available", items: [] }, providerUsage: { state: "not_available", items: [], totals: {} },
    artifacts: { state: "not_available", items: [] }, errors: { state: "not_available", items: [] },
    posture: { readOnly: true, sideEffectPosture: "audit_only", audit: { state: "available", note: "Read only" },
      replay: { state: "not_available", checkpointIds: [], note: "No replay" }, resume: { state: "not_available", eligible: false, note: "No resume" } },
  };
}

function snapshot(): DurableBackgroundTaskRailResponse {
  return {
    version: "durable.background_task_rail.v1", generatedAt: now,
    scope: { workspaceId: "workspace-a", sessionId: "session-a", verified: true },
    parent: { runId: "parent-run", status: "completed", version: 3, links: [] },
    coverage: { watchers: { complete: true, observedCount: 1, limit: 500 }, parentSignals: { complete: true, observedCount: 1, limit: 2_000 } },
    tasks: [{ watcherId: "watcher-a", watcherRevision: 1, watcherState: "closed", watcherUpdatedAt: now,
      childRunId: "child/a", canonicalStatus: "completed", label: "Verify changes", role: "QA",
      scope: { workspaceId: "workspace-a", sessionId: "child-session", verified: true },
      tools: [], toolCoverage: { complete: true, observedCount: 0, limit: 200 }, approvals: [],
      output: { availability: "available", source: "delegation_step", sourceId: "step-a", summary: "Focused checks passed.", sha256: "a".repeat(64), byteCount: 22 },
      blockers: [], attention: { state: "stopped", reason: "watcher_closed", updatedAt: now, required: false },
      signalIntegrity: { observedCount: 1, acceptedCount: 1, duplicateCount: 0, outOfOrderCount: 0, conflictingSequenceCount: 0, observationComplete: true, posture: "clean" },
      controls: { detach: { enabled: false }, reattach: { enabled: false }, cancel: { enabled: false } },
      links: [{ kind: "durable_run", id: "child/a", label: "Child run" }, { kind: "chat_session", id: "child-session", label: "Child conversation" }],
    }],
    synthesis: { availability: "available", summary: "The parent cited the verified checks.",
      lineage: [{ watcherId: "watcher-a", childRunId: "child/a", source: "delegation_step", sourceId: "step-a", sha256: "a".repeat(64), byteCount: 22,
        links: [{ kind: "durable_run", id: "child/a", label: "Cited child run" }] }],
      missingTerminalChildRunIds: [], uncoveredChildRunIds: [], uncoveredStepIds: [],
    }, unknowns: [],
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  api.fetchDurableBackgroundTaskRail.mockReset().mockResolvedValue(snapshot());
  api.controlDurableBackgroundTask.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render(value = trace(), workspaceId = "workspace-a") {
  await act(async () => root.render(<RunLineage trace={value} workspaceId={workspaceId} />));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}

describe("Work delegation lineage", () => {
  it("reads exact run/workspace/session lineage on demand and displays server-authored source links", async () => {
    await render();
    expect(api.fetchDurableBackgroundTaskRail).not.toHaveBeenCalled();
    await click("Inspect lineage");
    expect(api.fetchDurableBackgroundTaskRail).toHaveBeenCalledExactlyOnceWith(
      "parent-run", { sessionId: "session-a", workspaceId: "workspace-a" },
      { signal: expect.any(AbortSignal) },
    );
    expect(container.textContent).toContain("Verify changes");
    expect(container.textContent).toContain("Focused checks passed.");
    expect(container.textContent).toContain("The parent cited the verified checks.");
    expect(container.textContent).toContain("22 bytes · SHA-256");
    expect(container.textContent).toContain("Run status is current; output references describe recorded evidence");
    expect(container.querySelector('a[href="/work/runs/child%2Fa?shell=cockpit"]')).not.toBeNull();
    expect(container.querySelector('a[href="/chat?sessionId=child-session&shell=cockpit"]')).not.toBeNull();
    expect(api.controlDurableBackgroundTask).not.toHaveBeenCalled();
  });

  it("does not invent navigation when the owner omits semantic links", async () => {
    const value = snapshot(); value.tasks[0]!.links = []; value.synthesis.lineage[0]!.links = [];
    api.fetchDurableBackgroundTaskRail.mockResolvedValue(value);
    await render(); await click("Inspect lineage");
    expect(container.querySelector("a")).toBeNull();
  });

  it.each(["workspace", "canonical session", "canonical run", "missing lifecycle"])("withholds reads with inconsistent %s", async (reason) => {
    const value = trace();
    if (reason === "workspace") value.run.payload.workspaceId = "other";
    if (reason === "canonical session") value.lifecycle.response!.canonical.sessionId = "other";
    if (reason === "canonical run") value.lifecycle.response!.canonical.runId = "other";
    if (reason === "missing lifecycle") value.lifecycle.state = "not_available";
    await render(value);
    expect(container.textContent).toContain("Lineage unavailable");
    expect(api.fetchDurableBackgroundTaskRail).not.toHaveBeenCalled();
  });

  it.each(["workspace", "session", "parent"])("withholds a mismatched %s response", async (reason) => {
    const value = snapshot();
    if (reason === "workspace") value.scope.workspaceId = "other";
    if (reason === "session") value.scope.sessionId = "other";
    if (reason === "parent") value.parent.runId = "other";
    api.fetchDurableBackgroundTaskRail.mockResolvedValue(value);
    await render(); await click("Inspect lineage");
    expect(container.textContent).toContain("no matching run and workspace evidence");
    expect(container.textContent).not.toContain("Verify changes");
    expect(container.querySelector("a")).toBeNull();
  });

  it("preserves partial coverage, missing output, and uncovered synthesis distinctions", async () => {
    const value = snapshot();
    value.coverage.watchers.complete = false;
    value.coverage.parentSignals.complete = false;
    value.tasks[0]!.canonicalStatus = "unknown";
    value.tasks[0]!.output = { availability: "unknown" };
    value.synthesis = { availability: "partial", lineage: [], missingTerminalChildRunIds: ["child/a"], uncoveredChildRunIds: ["child/a"], uncoveredStepIds: ["step-a"] };
    value.unknowns = ["Retained signals did not cover every event."];
    api.fetchDurableBackgroundTaskRail.mockResolvedValue(value);
    await render(); await click("Inspect lineage");
    expect(container.textContent).toContain("Coverage is partial");
    expect(container.textContent).toContain("Status unavailable");
    expect(container.textContent).toContain("Output unknown");
    expect(container.textContent).toContain("Synthesis is partial");
    expect(container.textContent).toContain("does not cover 1 watched children and 1 delegation steps");
    expect(container.textContent).not.toContain("Focused checks passed.");
  });

  it("withholds unverified children and their source references", async () => {
    const value = snapshot(); value.tasks[0]!.scope.verified = false;
    api.fetchDurableBackgroundTaskRail.mockResolvedValue(value);
    await render(); await click("Inspect lineage");
    expect(container.textContent).toContain("unverified scope; details are withheld");
    expect(container.textContent).not.toContain("Verify changes");
    expect(container.textContent).not.toContain("SHA-256");
    expect(container.querySelector("a")).toBeNull();
  });

  it("bounds child and source lists without claiming all records are visible", async () => {
    const value = snapshot();
    value.tasks = Array.from({ length: 45 }, (_, i) => ({ ...value.tasks[0]!, watcherId: `watcher-${i}`, childRunId: `child-${i}` }));
    const source = value.synthesis.lineage[0]!;
    value.synthesis.lineage = value.tasks.map((task) => ({ ...source, watcherId: task.watcherId, childRunId: task.childRunId }));
    value.coverage.watchers.observedCount = 45;
    api.fetchDurableBackgroundTaskRail.mockResolvedValue(value);
    await render(); await click("Inspect lineage");
    expect(container.querySelectorAll('[aria-label="Watched child runs"] > li')).toHaveLength(40);
    expect(container.querySelectorAll('[aria-label="Recorded synthesis sources"] ol > li')).toHaveLength(40);
    expect(container.textContent).toContain("5 additional verified children");
    expect(container.textContent).toContain("5 additional cited sources");
  });

  it("withholds prior evidence after a refresh failure and distinguishes failure from empty", async () => {
    await render(); await click("Inspect lineage");
    const firstReadSignal = api.fetchDurableBackgroundTaskRail.mock.calls[0]![2].signal;
    api.fetchDurableBackgroundTaskRail.mockRejectedValueOnce(new Error("Gateway unavailable"));
    await click("Refresh lineage");
    expect(api.fetchDurableBackgroundTaskRail).toHaveBeenCalledTimes(2);
    expect(api.fetchDurableBackgroundTaskRail).toHaveBeenLastCalledWith(
      "parent-run", { sessionId: "session-a", workspaceId: "workspace-a" },
      { signal: expect.any(AbortSignal) },
    );
    expect(api.fetchDurableBackgroundTaskRail.mock.calls[1]![2].signal).not.toBe(firstReadSignal);
    expect(container.textContent).toContain("Gateway unavailable");
    expect(container.textContent).not.toContain("Verify changes");
    expect(container.textContent).not.toContain("No verified watched children");
  });

  it("does not publish an in-flight response after workspace changes", async () => {
    let resolve!: (value: DurableBackgroundTaskRailResponse) => void;
    api.fetchDurableBackgroundTaskRail.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render(); await click("Inspect lineage");
    await render(trace(), "workspace-b");
    await act(async () => resolve(snapshot()));
    expect(container.textContent).not.toContain("Verify changes");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("Lineage unavailable");
  });
});
