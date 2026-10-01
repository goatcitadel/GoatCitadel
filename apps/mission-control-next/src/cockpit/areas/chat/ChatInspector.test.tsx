// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MissionThreadedContextDockProps, MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInspector } from "./ChatInspector";

const { documentsPanel } = vi.hoisted(() => ({ documentsPanel: vi.fn() }));
vi.mock("../../../features/threaded-surface/ThreadedDocumentsPanel", () => ({
  ThreadedDocumentsPanel: ({ props }: { props: MissionThreadedContextDockProps }) => {
    documentsPanel(props);
    return <p>Shared documents editor</p>;
  },
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  documentsPanel.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function fixture(): MissionThreadedRenderSurfaceInput {
  return {
    sessionRail: { selectedSessionId: "session-1" },
    activeSessionSurfaceProps: {
      selectedSessionId: "session-1",
      selectedTurnId: "turn-1",
      thread: { turns: [{
        turnId: "turn-1", branch: { isSelectedPath: true },
        trace: { sessionId: "session-1", turnId: "turn-1", status: "completed", model: "example-model", completion: { latencyMs: 2100, usage: { costUsd: 0.0123, costSource: "provider_reported" } } },
        toolRuns: [{ toolRunId: "tool-1", toolName: "search", status: "executed" }],
        citations: [{ citationId: "source-1", title: "Evidence", url: "https://example.com/evidence", sourceType: "web" }],
      }] },
      selectedContextTurnIds: [],
      onReviewRunDetails: vi.fn(), onOpenRunDetails: vi.fn(),
    },
    contextDockProps: { selectedSessionId: "session-1", documents: { includedRefs: [] }, prefs: { memoryMode: "auto" } },
  } as unknown as MissionThreadedRenderSurfaceInput;
}

describe("conversation inspector", () => {
  it("shows captured turn evidence, safe sources, and the shared document editor", async () => {
    const input = fixture();
    await act(async () => root.render(<ChatInspector input={input} />));
    await act(async () => (container.querySelector('[role="tab"][aria-controls="cockpit-inspector-turn"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain("example-model");
    expect(container.textContent).toContain("$0.0123");
    await act(async () => (container.querySelector('[role="tab"][aria-controls="cockpit-inspector-sources"]') as HTMLButtonElement).click());
    expect(container.querySelector('a[href="https://example.com/evidence"]')?.textContent).toBe("Evidence");
    await act(async () => (container.querySelector('[role="tab"][aria-controls="cockpit-inspector-files"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain("Shared documents editor");
    expect(documentsPanel).toHaveBeenLastCalledWith(input.contextDockProps);
    expect(documentsPanel.mock.calls.at(-1)?.[0]).toBe(input.contextDockProps);
    expect(container.querySelector('.cockpit-chat-documents .mc-next-context-drawer[data-mode="chat"]')).not.toBeNull();
  });

  it("preserves the shared document conflict notices and exact retry/discard callbacks", async () => {
    const input = fixture();
    const dock = input.contextDockProps!;
    dock.preferenceConflictDraft = { memoryMode: "off", expectedRevision: 2 };
    dock.onRetryPreferenceConflictDraft = vi.fn(async () => undefined);
    dock.onDiscardPreferenceConflictDraft = vi.fn();
    dock.proactivePolicyConflict = true;
    dock.proactivePolicyDraft = { proactiveMode: "off" };
    dock.onProactivePolicyPatch = vi.fn(async () => undefined);
    await act(async () => root.render(<ChatInspector input={input} initialTab="files" />));
    expect(container.textContent).toContain("Pending: memory mode.");
    expect(container.textContent).toContain("Unsaved policy draft");
    const click = async (label: string) => act(async () => {
      const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
      expect(button).toBeDefined();
      button!.click();
    });
    await click("Retry preference changes");
    await click("Discard preference draft");
    await click("Retry preserved changes");
    expect(dock.onRetryPreferenceConflictDraft).toHaveBeenCalledTimes(1);
    expect(dock.onDiscardPreferenceConflictDraft).toHaveBeenCalledTimes(1);
    expect(dock.onProactivePolicyPatch).toHaveBeenCalledWith(dock.proactivePolicyDraft);
    expect(documentsPanel.mock.calls.at(-1)?.[0]).toBe(dock);
  });

  it("does not associate another turn's delegation with the selected turn", async () => {
    const input = fixture();
    input.activeSessionSurfaceProps!.delegationRun = { attachedTurnId: "older-turn", label: "Older delegation", objective: "Older work", steps: [] } as never;
    await act(async () => root.render(<ChatInspector input={input} />));
    expect(container.textContent).toContain("No delegation run is linked to this turn");
    expect(container.textContent).not.toContain("Older delegation");
  });

  it("keeps recorded step output inspectable and renders it as text", async () => {
    const input = fixture();
    input.activeSessionSurfaceProps!.delegationRun = {
      attachedTurnId: "turn-1", label: "Delegation", objective: "Recorded work", status: "partial",
      steps: [{ stepId: "step-1", index: 0, label: "Review", status: "failed",
        summary: "Partial review", error: "Verification failed",
        output: "<script>unsafeFixture()</script>\nRecorded review details" }],
    } as never;
    await act(async () => root.render(<ChatInspector input={input} />));
    expect(container.textContent).toContain("Partial review");
    expect(container.textContent).toContain("Verification failed");
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Recorded output");
    expect(details.textContent).toContain("<script>unsafeFixture()</script>");
    expect(container.querySelector("script")).toBeNull();
    input.activeSessionSurfaceProps!.selectedTurnId = "other-turn";
    await act(async () => root.render(<ChatInspector input={input} targetTurnId="turn-1" />));
    expect(container.textContent).toContain("Recorded review details");
    input.activeSessionSurfaceProps!.thread!.turns[0]!.branch.isSelectedPath = false;
    await act(async () => root.render(<ChatInspector input={input} />));
    expect(container.textContent).not.toContain("Recorded review details");
  });

  it("separates recorded turn context from current settings and scopes source inspection", async () => {
    const input = fixture();
    const turn = input.activeSessionSurfaceProps!.thread!.turns[0]!;
    turn.trace.sessionId = "session-1";
    turn.trace.turnId = "turn-1";
    turn.trace.memoryMode = "on";
    turn.trace.webMode = "auto";
    turn.trace.capabilityProfileId = "profile-1";
    turn.trace.capabilityProfileHash = "profile-hash-1";
    turn.trace.guidance = { workspaceId: "workspace-1", globalFilesUsed: ["global.md"], workspaceFilesUsed: ["workspace.md"], truncated: false };
    turn.trace.routing = {
      promptContextBudget: { tokenEstimates: { total: 780 } },
      routedContext: { snapshotId: "snapshot-1", snapshotHash: "abcdef0123456789", sourceRequestHash: "request-hash", contentHash: "content-hash" },
    } as never;
    input.contextDockProps!.selectedSessionId = "session-1";
    input.contextDockProps!.selectedTurn = turn;
    input.contextDockProps!.prefs = { memoryMode: "off" } as never;
    input.contextDockProps!.capabilityProfileInspection = {
      status: "verified", profile: {} as never, mismatchFields: [],
      expectedProfileId: "profile-1", expectedProfileHash: "profile-hash-1",
      routedContext: {
        snapshotId: "snapshot-1", snapshotHash: "abcdef0123456789", sourceRequestHash: "request-hash", contentHash: "content-hash",
        includedCount: 1, truncatedCount: 0, omittedCount: 0,
        budget: { usedTokens: 240, effectiveBudgetTokens: 1000 },
        entries: [{ index: 0, sourceHash: "source-hash", label: "Scoped document", disposition: "included" }],
      },
    } as never;

    await act(async () => root.render(<ChatInspector input={input} initialTab="context" />));
    expect(container.querySelector('[aria-label="Recorded turn context"]')?.textContent).toContain("Memory modeOn");
    expect(container.querySelector('[aria-label="Recorded turn context"]')?.textContent).toContain("780 tokens (estimated)");
    expect(container.querySelector('[aria-label="Current context selection"]')?.textContent).toContain("Memory modeOff");
    expect(container.querySelector('[aria-label="Verified routed context"]')?.textContent).toContain("Scoped document");

    input.contextDockProps!.selectedTurn = { turnId: "another-turn" } as never;
    await act(async () => root.render(<ChatInspector input={input} initialTab="context" />));
    expect(container.querySelector('[aria-label="Verified routed context"]')).toBeNull();
    expect(container.textContent).toContain("Scoped source details are unavailable");

    input.contextDockProps!.selectedSessionId = "another-session";
    await act(async () => root.render(<ChatInspector input={input} initialTab="context" />));
    expect(container.querySelector('[aria-label="Current context selection"]')?.textContent).toContain("unavailable until this session is selected");
    expect(container.querySelector('[aria-label="Recorded turn context"]')?.textContent).toContain("Select a conversation turn");
    expect(container.textContent).not.toContain("Scoped document");
  });

  it("shows next-turn context in a selected conversation with no turns yet", async () => {
    const input = fixture();
    input.activeSessionSurfaceProps!.thread = { turns: [] } as never;
    input.activeSessionSurfaceProps!.selectedTurnId = null;
    await act(async () => root.render(<ChatInspector input={input} initialTab="context" />));
    expect(container.querySelector('[aria-label="Recorded turn context"]')?.textContent).toContain("Select a conversation turn");
    expect(container.querySelector('[aria-label="Current context selection"]')?.textContent).toContain("Memory modeAuto");
  });

  it("shows the opened artifact content only for its selected session and turn", async () => {
    const input = fixture();
    input.contextDockProps!.selectedSessionId = "session-1";
    input.contextDockProps!.activeGeneratedArtifact = {
      artifactId: "artifact-1", sessionId: "session-1", turnId: "turn-1", title: "Saved note",
      kind: "text", content: "Verified artifact body", sourceSurface: "chat", version: 1,
      createdAt: "2026-09-29T00:00:00.000Z",
    } as never;
    await act(async () => root.render(<ChatInspector input={input} initialTab="files" />));
    expect(container.querySelector('[aria-label="Selected artifact"]')?.textContent).toContain("Verified artifact body");

    input.contextDockProps!.selectedSessionId = "session-2";
    await act(async () => root.render(<ChatInspector input={input} initialTab="files" />));
    expect(container.querySelector('[aria-label="Selected artifact"]')).toBeNull();
  });
});
