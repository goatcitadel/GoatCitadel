// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE, type ApprovalRequest, type OperatorInboxItem } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxApprovalActions } from "./InboxApprovalActions";
import { ApprovalDecisionBar } from "./ApprovalDecisionBar";
import { __resetInboxApprovalAttemptsForTests } from "./inbox-approval-attempts";

const api = vi.hoisted(() => ({ fetchApproval: vi.fn(), resolveApproval: vi.fn() }));
const preferences = vi.hoisted(() => ({ activeWorkspaceId: "default", showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ resolveApproval: api.resolveApproval }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.fetchApproval }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));

const approval: ApprovalRequest = {
  approvalId: "approval-a",
  kind: "file.write",
  riskLevel: "danger",
  status: "pending",
  payload: {},
  preview: { targets: ["workspace/note.txt"] },
  createdAt: "2026-09-28T00:00:00Z",
  explanationStatus: "pending",
};
const item: OperatorInboxItem = {
  id: "approval:approval-a",
  kind: "approval",
  group: "needs_decision",
  title: "Review file write",
  summary: "Review",
  createdAt: approval.createdAt,
  source: { workspaceId: "default", approvalId: "approval-a" },
  href: "/ops/approvals",
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  __resetInboxApprovalAttemptsForTests();
  preferences.activeWorkspaceId = "default";
  preferences.showTechnicalDetails = false;
  api.fetchApproval.mockReset();
  api.resolveApproval.mockReset();
  api.fetchApproval.mockResolvedValue(approval);
  api.resolveApproval.mockResolvedValue({ approval: { ...approval, status: "approved" }, effects: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.useRealTimers();
});

function renderActions(
  reviewed: ApprovalRequest,
  onResolved = vi.fn<(message: string) => void>(),
  onInvalidated = vi.fn<() => void>(),
  selected = item,
  workspaceId = "default",
) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <InboxApprovalActions
          item={selected}
          approval={reviewed}
          workspaceId={workspaceId}
          onResolved={onResolved}
          onInvalidated={onInvalidated}
        />
      </QueryClientProvider>,
    ),
  );
  return { onResolved, onInvalidated };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function approve() {
  await act(async () => button("Review approval").click());
  await act(async () => button("Approve once").click());
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
}

async function typeConfirmation(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input');
  if (!input) throw new Error("Missing confirmation input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Inbox approval decisions", () => {
  function knowledgeApproval(legacy = false): ApprovalRequest {
    const payload = {
      workspaceId: "default", sessionId: "session", sessionIncarnationId: "incarnation", sourceId: "source",
      importId: "import", itemId: "item", attachmentId: "attachment", attachmentRevision: 1,
      rawSha256: "b".repeat(64), normalizedArtifactSha256: "a".repeat(64),
    };
    return { ...approval, kind: "external_source.knowledge_snapshot", payload,
      linkage: { workspaceId: "default", sessionId: "session" },
      preview: { sourceId: "source", importId: "import", itemId: "item", attachmentId: "attachment",
        normalizedArtifactSha256: payload.normalizedArtifactSha256, normalizedByteCount: 512,
        ...(!legacy ? { review: { version: 1, sourceLabel: "Original source", itemPath: "sessions/original.jsonl",
          target: "Knowledge copy of sessions/original.jsonl from Original source",
          scopeSummary: "Workspace default; conversation session.", consequence: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE,
        } } : {}),
      },
    };
  }
  it.each([false, true])("reviews the exact %s legacy Knowledge copy: Cancel sends zero decisions; confirm sends the original once", async legacy => {
    const record = knowledgeApproval(legacy);
    api.fetchApproval.mockResolvedValue(record);
    api.resolveApproval.mockResolvedValue({ approval: { ...record, status: "approved" }, effects: [] });
    renderActions(record);
    await act(async () => button("Review approval").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(legacy ? "Knowledge copy of imported item item" : "Knowledge copy of sessions/original.jsonl from Original source");
    expect(dialog.textContent).toContain("Workspace default; conversation session.");
    expect(dialog.textContent).toContain(EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE);
    expect(dialog.textContent).toContain("This decision authorizes this request once.");
    expect(dialog.textContent).not.toContain("Snapshot provenance");
    expect(dialog.textContent).not.toContain("Normalized SHA-256");
    preferences.showTechnicalDetails = true;
    renderActions(record);
    const provenance = [...dialog.querySelectorAll("details")].find(detail => detail.querySelector("summary")?.textContent === "Snapshot provenance")!;
    expect(provenance.open).toBe(false);
    expect(provenance.textContent).toContain(`Normalized SHA-256: ${"a".repeat(64)}`);
    expect(provenance.textContent).toContain("Normalized bytes: 512");
    await act(async () => button("Cancel").click());
    expect(api.fetchApproval).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await approve();
    expect(api.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval-a", { workspaceId: "default" });
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "approve");
  });
  it.each(["missing", "changed-path", "changed-hash", "foreign-scope"])("blocks a Knowledge decision after %s preflight", async kind => {
    const record = knowledgeApproval();
    const changed = structuredClone(record);
    if (kind === "changed-path") (changed.preview!.review as Record<string, unknown>).itemPath = "other.jsonl";
    if (kind === "changed-hash") changed.payload.normalizedArtifactSha256 = "f".repeat(64);
    if (kind === "foreign-scope") changed.linkage!.workspaceId = "foreign";
    api.fetchApproval.mockResolvedValue(kind === "missing" ? undefined : changed);
    renderActions(record);
    await approve();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });
  it("keeps missing or contradictory Knowledge preview unavailable", () => {
    const record = knowledgeApproval();
    renderActions({ ...record, preview: {} });
    expect(container.textContent).toContain("exact action preview is unavailable");
    expect(container.querySelector("button")).toBeNull();
    renderActions({ ...record, preview: { ...record.preview, itemId: "foreign" } });
    expect(container.textContent).toContain("exact action preview is unavailable");
    expect(container.querySelector("button")).toBeNull();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });
  it("explains request changes and unavailable project grants without adding decision authority", async () => {
    renderActions(approval);
    expect(container.textContent).toContain("To change this request, open its source and submit a new request");
    expect(container.textContent).toContain("Editing an approval withdraws the original action");
    expect(container.textContent).toContain("does not authorize a replacement");
    expect(container.textContent).toContain("Project-wide always-allow is unavailable here");
    expect([...container.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual([
      "Review approval",
      "Deny",
    ]);
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await approve();
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "approve");
  });

  it("requires danger confirmation, then rereads the same pending owner record before approval", async () => {
    const { onResolved } = renderActions(approval);
    await act(async () => button("Review approval").click());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await act(async () => button("Approve once").click());
    expect(api.fetchApproval).toHaveBeenCalledWith("approval-a", { workspaceId: "default" });
    expect(api.resolveApproval).toHaveBeenCalledWith("approval-a", "approve");
    expect(onResolved).toHaveBeenCalledWith(expect.stringContaining("Follow-on execution needs separate verification"));
  });

  it("refuses a changed action even after confirmation", async () => {
    api.fetchApproval.mockResolvedValue({ ...approval, preview: { targets: ["other.txt"] } });
    const { onInvalidated } = renderActions(approval);
    await act(async () => button("Review approval").click());
    await act(async () => button("Approve once").click());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    expect(onInvalidated).toHaveBeenCalledOnce();
  });

  it("locks both decisions after a mutation response with an uncertain outcome", async () => {
    api.resolveApproval.mockRejectedValue(new Error("Connection lost"));
    renderActions(approval);
    await act(async () => button("Review approval").click());
    await act(async () => button("Approve once").click());
    expect(api.resolveApproval).toHaveBeenCalledOnce();
    expect(button("Review approval").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    expect(container.textContent).toContain("Decision outcome is uncertain");
  });

  it("allows another check when the owner read fails before a mutation", async () => {
    api.fetchApproval.mockRejectedValue(new Error("Connection lost"));
    renderActions(approval);
    await act(async () => button("Review approval").click());
    await act(async () => button("Approve once").click());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    expect(button("Review approval").disabled).toBe(false);
    expect(container.textContent).toContain("Could not check the current approval");
  });

  it("withholds specialist approval without matching evidence", () => {
    renderActions({ ...approval, kind: "code_mode.run" });
    expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Review approval")?.disabled).toBe(true);
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it.each(["workspace", "selection", "same-id evidence", "unmount"])(
    "cancels before POST when %s changes during the owner read",
    async (change) => {
      const read = deferred<ApprovalRequest>();
      api.fetchApproval.mockReturnValue(read.promise);
      const callbacks = renderActions(approval);
      await approve();
      if (change === "workspace") {
        preferences.activeWorkspaceId = "workspace-b";
        renderActions(approval);
      } else if (change === "selection") {
        renderActions({ ...approval, approvalId: "approval-b" }, undefined, undefined, {
          ...item,
          id: "approval:approval-b",
          source: { workspaceId: "default", approvalId: "approval-b" },
        });
      } else if (change === "same-id evidence") {
        renderActions({ ...approval, preview: { targets: ["other.txt"] } });
      } else {
        act(() => root.render(null));
      }
      await act(async () => read.resolve(approval));
      expect(api.resolveApproval).not.toHaveBeenCalled();
      expect(callbacks.onResolved).not.toHaveBeenCalled();
      expect(callbacks.onInvalidated).not.toHaveBeenCalled();
      preferences.activeWorkspaceId = "default";
      renderActions(approval);
      expect(button("Review approval").disabled).toBe(false);
    },
  );

  it("does not carry an open danger or deny confirmation to another selected record", async () => {
    renderActions(approval);
    await act(async () => button("Review approval").click());
    renderActions({ ...approval, preview: { targets: ["new-target.txt"] } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button("Deny").click());
    renderActions(approval);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("retains the pending and uncertain lock after remount, without notifying the new detail", async () => {
    const result = deferred<{ approval: ApprovalRequest; effects: [] }>();
    api.resolveApproval.mockReturnValue(result.promise);
    const original = renderActions(approval);
    await approve();
    expect(api.resolveApproval).toHaveBeenCalledOnce();
    act(() => root.render(null));
    const next = renderActions(approval);
    expect(button("Review approval").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    await act(async () => result.reject(new Error("Response lost")));
    expect(original.onResolved).not.toHaveBeenCalled();
    expect(next.onResolved).not.toHaveBeenCalled();
    act(() => root.render(null));
    renderActions(approval);
    expect(container.textContent).toContain("Decision outcome is uncertain");
    expect(button("Review approval").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    expect(api.resolveApproval).toHaveBeenCalledOnce();
  });

  it("retains a verified decision after navigation without applying its callback to a different selection", async () => {
    const result = deferred<{ approval: ApprovalRequest; effects: [] }>();
    api.resolveApproval.mockReturnValue(result.promise);
    const original = renderActions(approval);
    await approve();
    const next = renderActions({ ...approval, approvalId: "approval-b" }, undefined, undefined, {
      ...item,
      id: "approval:approval-b",
      source: { workspaceId: "default", approvalId: "approval-b" },
    });
    await act(async () => result.resolve({ approval: { ...approval, status: "approved" }, effects: [] }));
    expect(original.onResolved).not.toHaveBeenCalled();
    expect(next.onResolved).not.toHaveBeenCalled();
    expect(button("Review approval").disabled).toBe(false);
    renderActions(approval);
    expect(button("Review approval").disabled).toBe(true);
    expect(container.textContent).toContain("Decision recorded");
  });

  it.each([
    { approvalId: "approval-b" },
    { status: "pending" as const },
    { status: "rejected" as const },
    { linkage: { workspaceId: "other" } },
    { preview: { targets: ["other.txt"] } },
  ])("withholds success and retains the lock for a mismatched response %j", async (mismatch) => {
    api.resolveApproval.mockResolvedValue({ approval: { ...approval, status: "approved", ...mismatch }, effects: [] });
    const { onResolved } = renderActions(approval);
    await approve();
    expect(onResolved).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Decision outcome is uncertain");
    expect(button("Deny").disabled).toBe(true);
  });

  it("keeps the original scope lock while another workspace can review its own request", async () => {
    api.resolveApproval.mockRejectedValue(new Error("Response lost"));
    renderActions(approval);
    await approve();
    preferences.activeWorkspaceId = "workspace-b";
    renderActions(
      approval,
      undefined,
      undefined,
      { ...item, source: { ...item.source, workspaceId: "workspace-b" } },
      "workspace-b",
    );
    expect(button("Review approval").disabled).toBe(false);
    preferences.activeWorkspaceId = "default";
    renderActions(approval);
    expect(button("Review approval").disabled).toBe(true);
  });

  it("rechecks and validates a denied receipt separately from approval", async () => {
    api.resolveApproval.mockResolvedValue({ approval: { ...approval, status: "rejected" }, effects: [] });
    const { onResolved } = renderActions(approval);
    await act(async () => button("Deny").click());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await act(async () => button("Confirm deny").click());
    expect(api.resolveApproval).toHaveBeenCalledWith("approval-a", "reject");
    expect(onResolved).toHaveBeenCalledWith(expect.stringContaining("Decision recorded"));
  });

  it("requires the typed nuclear confirmation, then rereads the same pending owner record before approval", async () => {
    const nuclear: ApprovalRequest = { ...approval, riskLevel: "nuclear" };
    api.fetchApproval.mockResolvedValue(nuclear);
    api.resolveApproval.mockResolvedValue({ approval: { ...nuclear, status: "approved" }, effects: [] });
    const { onResolved } = renderActions(nuclear);
    await act(async () => button("Review approval").click());
    expect(button("Approve once").disabled).toBe(true);
    await typeConfirmation("approve");
    expect(button("Approve once").disabled).toBe(false);
    expect(api.fetchApproval).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await act(async () => button("Approve once").click());
    expect(api.fetchApproval).toHaveBeenCalledWith("approval-a", { workspaceId: "default" });
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "approve");
    expect(onResolved).toHaveBeenCalledWith(expect.stringContaining("Decision recorded"));
  });

  it("closes an open nuclear confirmation when its reviewed evidence changes", async () => {
    renderActions({ ...approval, riskLevel: "nuclear" });
    await act(async () => button("Review approval").click());
    await typeConfirmation("approve");
    expect(button("Approve once").disabled).toBe(false);
    renderActions({ ...approval, riskLevel: "nuclear", preview: { targets: ["new-target.txt"] } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button("Review approval").click());
    expect(button("Approve once").disabled).toBe(true);
    expect(api.fetchApproval).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("refuses a record that expires while its owner read is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    const reviewed = { ...approval, expiresAt: "2026-09-30T00:00:01Z" };
    const read = deferred<ApprovalRequest>();
    api.fetchApproval.mockReturnValue(read.promise);
    renderActions(reviewed);
    await approve();
    vi.setSystemTime(new Date("2026-09-30T00:00:02Z"));
    await act(async () => read.resolve(reviewed));
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });
});
it.each(["Use the local store for project decisions", "  First line\nSecond line\n", "Decision: password=[REDACTED]"])("shows the exact redacted memory body before the native decision: %s", content => {
  const memory: ApprovalRequest = { ...approval, kind: "memory.write", riskLevel: "caution", preview: { toolName: "memory.write", target: "Memory namespace: project-memory", content, summary: "Persist this exact memory document after approval" } };
  renderActions(memory);
  const details = [...container.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "Memory content");
  expect(details?.open).toBe(true);
  expect(details?.querySelector("pre")?.textContent).toBe(content);
  expect(button("Approve once").disabled).toBe(false);
  expect(api.resolveApproval).not.toHaveBeenCalled();
});

it.each(["One sentence", "  First line\nSecond line\n", "password=[REDACTED]"])("opens exact persisted lifecycle values for independent Inbox review: %s", async content => {
  renderActions({ ...approval, kind: "memory.lifecycle", riskLevel: "danger", preview: { reviewKind: "memory.lifecycle.patch", target: "Original title", requestedTitle: "New title", requestedContent: content, pinnedSummary: "Requested pinned state: pinned", ttlSummary: "Requested TTL: clear override", withheldSummary: "Metadata withheld" } });
  await act(async () => button("Review approval").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const details = [...dialog.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "Requested memory content");
  expect(details?.open).toBe(true);
  expect(details?.querySelector("pre")?.textContent).toBe(content);
  expect(dialog.textContent).toContain("New title");
  expect(dialog.textContent).toContain("Requested pinned state: pinned");
  expect(dialog.textContent).toContain("Requested TTL: clear override");
  expect(api.resolveApproval).not.toHaveBeenCalled();
});

it.each(["approved", "rejected", "edited"] as const)("makes a newly loaded %s record visibly non-actionable without a local attempt", status => {
  renderActions({ ...approval, status });
  expect(container.textContent).toContain(`Decision recorded: ${status}`);
  expect(container.querySelector("button")).toBeNull();
  expect(api.resolveApproval).not.toHaveBeenCalled();
});

it("removes decision dialogs when a still-pending record expires in the mounted review", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-06T00:00:00Z"));
  renderActions({ ...approval, expiresAt: "2026-10-06T00:00:01Z" });
  await act(async () => button("Deny").click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(2000));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("This approval has expired");
  expect(api.resolveApproval).not.toHaveBeenCalled();
});

it.each(["approved", "rejected"] as const)("closes both kinds of dialog when external %s settlement arrives", async status => {
  for (const opener of ["Review approval", "Deny"]) {
    renderActions(approval);
    await act(async () => button(opener).click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    renderActions({ ...approval, status });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain(`Decision recorded: ${status}`);
  }
  expect(api.fetchApproval).not.toHaveBeenCalled();
  expect(api.resolveApproval).not.toHaveBeenCalled();
});

it("locks the shared Library and Chat owner during checking and after canonical settlement", () => {
  const renderShared = (record: ApprovalRequest, checking: boolean) => act(() => root.render(<QueryClientProvider client={client}><ApprovalDecisionBar approval={record} workspaceId="default" checking={checking} onResolved={vi.fn()} onInvalidated={vi.fn()} /></QueryClientProvider>));
  renderShared(approval, true);
  expect(button("Review approval").disabled).toBe(true);
  expect(button("Deny").disabled).toBe(true);
  renderShared({ ...approval, status: "approved" }, false);
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("Decision recorded: approved");
});
