// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/chat";
import type { ObserveRunTraceResponse } from "@goatcitadel/mission-control-shared/api/durable";
import { queryKeys } from "../../data/query-keys";
import { RunArtifacts } from "./RunArtifacts";

vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatGeneratedArtifact: vi.fn() }));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? <section role="dialog" aria-label={title}>{children}</section> : null,
}));

const artifact: ChatGeneratedArtifactRecord = {
  artifactId: "artifact-a", workspaceId: "workspace-a", sessionId: "session-a", turnId: "turn-a",
  title: "Saved report", kind: "text", content: "Recorded report content", sourceSurface: "chat",
  version: 2, contentHash: "a".repeat(64), createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z",
};

function trace(items = [artifact]): ObserveRunTraceResponse {
  return { version: "observe.run_trace.v1", generatedAt: artifact.updatedAt, runId: "run-a",
    run: { runId: "run-a", workflowKey: "chat.turn.execute", status: "completed", version: 1,
      attemptCount: 1, maxAttempts: 3, payload: { workspaceId: "workspace-a" }, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt },
    durable: { checkpoints: { state: "not_available", items: [] }, timeline: { state: "not_available", items: [] } },
    lifecycle: { state: "not_available" }, session: { state: "not_available" }, thread: { state: "not_available", turns: [] },
    approvals: { state: "not_available", items: [], missingIds: [] }, toolCalls: { state: "not_available", items: [] },
    memoryContext: { state: "not_available", items: [] }, providerUsage: { state: "not_available", items: [], totals: {} },
    artifacts: { state: "available", items }, errors: { state: "not_available", items: [] },
    posture: { readOnly: true, sideEffectPosture: "audit_only", audit: { state: "available", note: "Read only" },
      replay: { state: "not_available", checkpointIds: [], note: "No replay" }, resume: { state: "not_available", eligible: false, note: "No resume" } },
  };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchChatGeneratedArtifact).mockReset().mockResolvedValue({ item: artifact });
});
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); });

async function render(value = trace(), workspaceId = "workspace-a") {
  await act(async () => root.render(<QueryClientProvider client={client}><RunArtifacts trace={value} workspaceId={workspaceId} /></QueryClientProvider>));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}

describe("Work run artifact preview", () => {
  it("reads the scoped artifact on demand and preserves the shared HTML sandbox", async () => {
    const html = { ...artifact, kind: "html" as const, content: "<h1>Recorded report</h1>" };
    vi.mocked(fetchChatGeneratedArtifact).mockResolvedValue({ item: html });
    await render(trace([html]));
    expect(fetchChatGeneratedArtifact).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
    await click("Preview artifact");
    expect(fetchChatGeneratedArtifact).toHaveBeenCalledWith("artifact-a", "workspace-a");
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toBe(html.content);
    expect(container.querySelector('a[href="/chat?sessionId=session-a&shell=cockpit"]')).not.toBeNull();
  });

  it("withholds foreign and unscoped artifacts and all artifacts from a foreign run", async () => {
    await render(trace([{ ...artifact, artifactId: "foreign", workspaceId: "workspace-b", title: "Foreign secret" },
      { ...artifact, artifactId: "unbound", workspaceId: undefined, title: "Unbound secret" }, artifact]));
    expect(container.textContent).not.toContain("secret");
    expect(container.querySelectorAll("li")).toHaveLength(1);
    const foreign = trace();
    foreign.run.payload.workspaceId = "workspace-b";
    await render(foreign);
    expect(container.textContent).not.toContain(artifact.title);
    expect(container.textContent).toContain("no matching run workspace");
    expect(fetchChatGeneratedArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ["artifact ID", { artifactId: "other" }], ["workspace", { workspaceId: "other" }],
    ["session", { sessionId: "other" }], ["turn", { turnId: "other" }],
    ["version", { version: 3 }], ["hash", { contentHash: "b".repeat(64) }], ["kind", { kind: "markdown" as const }],
  ])("withholds content when the owner response has a different %s", async (_label, overrides) => {
    vi.mocked(fetchChatGeneratedArtifact).mockResolvedValue({ item: { ...artifact, ...overrides, content: "DO NOT DISPLAY" } });
    await render();
    await click("Preview artifact");
    expect(container.textContent).not.toContain("DO NOT DISPLAY");
    expect(container.textContent).toContain("no longer matches");
    expect(container.textContent).toContain("Refresh run evidence");
  });

  it("withholds content after a failed owner read", async () => {
    vi.mocked(fetchChatGeneratedArtifact).mockRejectedValue(new Error("Artifact service unavailable"));
    await render();
    await click("Preview artifact");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Artifact service unavailable");
    expect(container.textContent).not.toContain(artifact.content);
  });

  it("withholds an already open preview when run evidence changes and refreshes its owner query", async () => {
    await render();
    await click("Preview artifact");
    expect(container.textContent).toContain(artifact.content);
    await render(trace([{ ...artifact, version: 3 }]));
    expect(container.textContent).not.toContain(artifact.content);
    expect(container.textContent).toContain("Run evidence changed");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await click("Refresh run evidence");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runTrace("run-a") });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("ignores an in-flight response after the workspace changes", async () => {
    let resolve!: (value: { item: ChatGeneratedArtifactRecord }) => void;
    vi.mocked(fetchChatGeneratedArtifact).mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    await click("Preview artifact");
    expect(container.textContent).toContain("Loading the recorded artifact");
    await render(trace(), "workspace-b");
    await act(async () => resolve({ item: artifact }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain(artifact.content);
  });

  it("requires a recorded hash and keeps oversized content out of the viewer", async () => {
    await render(trace([{ ...artifact, contentHash: undefined }]));
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(fetchChatGeneratedArtifact).not.toHaveBeenCalled();
    await render();
    vi.mocked(fetchChatGeneratedArtifact).mockResolvedValue({ item: { ...artifact, content: "x".repeat(256 * 1024 + 1) } });
    await click("Preview artifact");
    expect(container.textContent).toContain("too large for the bounded preview");
    expect(container.querySelector(".generated-artifact-viewer")).toBeNull();
  });

  it("preserves the Gateway redacted projection without claiming its bytes match the stored hash", async () => {
    vi.mocked(fetchChatGeneratedArtifact).mockResolvedValue({ item: { ...artifact, content: "[REDACTED] report",
      publicProjection: { contentRedacted: true, redactedPaths: ["content"], canonicalContentHashRefersToStoredArtifact: true } } });
    await render();
    await click("Preview artifact");
    expect(container.textContent).toContain("[REDACTED] report");
    expect(container.textContent).toContain("The recorded hash identifies the stored artifact");
  });

  it("withholds artifact summaries and content when their trace source becomes unavailable", async () => {
    await render();
    await click("Preview artifact");
    const unavailable = trace();
    unavailable.artifacts.state = "unknown";
    await render(unavailable);
    expect(container.textContent).not.toContain(artifact.title);
    expect(container.textContent).not.toContain(artifact.content);
    expect(container.textContent).toContain("Artifact evidence is unknown");
    expect(container.textContent).toContain("Run evidence changed");
  });
});
