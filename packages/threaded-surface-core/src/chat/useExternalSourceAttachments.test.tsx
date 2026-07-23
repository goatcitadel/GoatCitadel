import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalSessionAttachmentRecord } from "@goatcitadel/contracts";
import { useExternalSourceAttachments, type ExternalSourceAttachmentsState } from "./useExternalSourceAttachments";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  fetchExternalSessionAttachments: vi.fn(),
  attachExternalSourceToSession: vi.fn(),
  detachExternalSourceAttachment: vi.fn(),
  requestExternalSourceKnowledgeSnapshot: vi.fn(),
  isExternalSourceCapabilityAbsent: (error: unknown) => (error as { status?: number } | null)?.status === 404,
}));

vi.mock("@goatcitadel/mission-control-shared/api/external-sources", () => apiMocks);

const timestamp = "2026-07-14T08:00:00.000Z";
const hash = (value: string): string => value.repeat(64).slice(0, 64);

function attachment(
  id: string,
  overrides: Partial<ExternalSessionAttachmentRecord> = {},
): ExternalSessionAttachmentRecord {
  return {
    schemaVersion: "goatcitadel.external-source.v1",
    attachmentId: id,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sourceId: "source-1",
    importId: "import-1",
    itemId: `item-${id}`,
    normalizedArtifactSha256: hash("1"),
    mode: "read_only_external",
    status: "attached",
    revision: 1,
    attachedByActorId: "operator-1",
    attachedAt: timestamp,
    ...overrides,
  };
}

function listResponse(items: ExternalSessionAttachmentRecord[], sessionIncarnationId?: string) {
  return {
    schemaVersion: "goatcitadel.external-source.v1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    ...(sessionIncarnationId !== undefined ? { sessionIncarnationId } : {}),
    items,
  };
}

let latest: ExternalSourceAttachmentsState | null = null;
const pushLocalNotice = vi.fn();

function Harness(props: { sessionId?: string | null; sessionIncarnationId?: string | null }) {
  latest = useExternalSourceAttachments({
    workspaceId: "workspace-1",
    sessionId: props.sessionId === undefined ? "session-1" : props.sessionId,
    sessionIncarnationId: props.sessionIncarnationId,
    pushLocalNotice,
  });
  return null;
}

async function renderHarness(props: Parameters<typeof Harness>[0] = {}): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(<Harness {...props} />);
  });
  return renderer!;
}

beforeEach(() => {
  latest = null;
  pushLocalNotice.mockClear();
  apiMocks.fetchExternalSessionAttachments.mockReset();
  apiMocks.attachExternalSourceToSession.mockReset();
  apiMocks.detachExternalSourceAttachment.mockReset();
  apiMocks.requestExternalSourceKnowledgeSnapshot.mockReset();
});

describe("useExternalSourceAttachments", () => {
  it("loads live attachments and exposes only attached records", async () => {
    apiMocks.fetchExternalSessionAttachments.mockResolvedValue(
      listResponse([
        attachment("attachment-1"),
        attachment("attachment-2", {
          status: "detached",
          revision: 2,
          detachedAt: timestamp,
          detachedByActorId: "operator-1",
        }),
      ]),
    );
    const renderer = await renderHarness();

    expect(apiMocks.fetchExternalSessionAttachments).toHaveBeenCalledWith("session-1", "workspace-1");
    expect(latest!.supported).toBe(true);
    expect(latest!.attachments.map((item) => item.attachmentId)).toEqual(["attachment-1"]);
    expect(latest!.error).toBeNull();
    renderer.unmount();
  });

  it("degrades gracefully when the routes are absent: supported=false, no error, no notice spam", async () => {
    apiMocks.fetchExternalSessionAttachments.mockRejectedValue({ status: 404 });
    const renderer = await renderHarness();

    expect(latest!.supported).toBe(false);
    expect(latest!.error).toBeNull();
    expect(latest!.attachments).toEqual([]);
    expect(latest!.canMutate).toBe(false);
    expect(pushLocalNotice).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("surfaces a non-404 load failure as a bounded error message", async () => {
    apiMocks.fetchExternalSessionAttachments.mockRejectedValue({ status: 500 });
    const renderer = await renderHarness();

    expect(latest!.error).toContain("unavailable");
    expect(latest!.supported).toBeNull();
    renderer.unmount();
  });

  it("stays idle without a session", async () => {
    const renderer = await renderHarness({ sessionId: null });
    expect(apiMocks.fetchExternalSessionAttachments).not.toHaveBeenCalled();
    expect(latest!.supported).toBeNull();
    expect(latest!.loading).toBe(false);
    renderer.unmount();
  });

  it("toggles explicit per-turn selection only across live attachments and clears it on demand", async () => {
    apiMocks.fetchExternalSessionAttachments.mockResolvedValue(
      listResponse([attachment("attachment-1"), attachment("attachment-2")]),
    );
    const renderer = await renderHarness();

    await act(async () => latest!.toggleSelection("attachment-1"));
    await act(async () => latest!.toggleSelection("attachment-2"));
    await act(async () => latest!.toggleSelection("missing-attachment"));
    expect(latest!.selectedAttachmentIds).toEqual(["attachment-1", "attachment-2"]);

    await act(async () => latest!.toggleSelection("attachment-1"));
    expect(latest!.selectedAttachmentIds).toEqual(["attachment-2"]);

    await act(async () => latest!.clearSelection());
    expect(latest!.selectedAttachmentIds).toEqual([]);
    renderer.unmount();
  });

  it("freezes the current selection into external_attachment context refs", async () => {
    apiMocks.fetchExternalSessionAttachments.mockResolvedValue(
      listResponse([attachment("attachment-1"), attachment("attachment-2")]),
    );
    const renderer = await renderHarness();
    await act(async () => latest!.toggleSelection("attachment-2"));
    await act(async () => latest!.toggleSelection("attachment-1"));

    const refs = latest!.captureOutboundExternalContextRefs();
    expect(refs).toEqual([
      { kind: "external_attachment", ref: "attachment-2", label: "External item-attachment-2" },
      { kind: "external_attachment", ref: "attachment-1", label: "External item-attachment-1" },
    ]);
    renderer.unmount();
  });

  it("clears exactly the sent refs after a successful send and keeps later selections", async () => {
    apiMocks.fetchExternalSessionAttachments.mockResolvedValue(
      listResponse([attachment("attachment-1"), attachment("attachment-2")]),
    );
    const renderer = await renderHarness();
    await act(async () => latest!.toggleSelection("attachment-1"));
    const frozen = latest!.captureOutboundExternalContextRefs();
    // The operator selects another attachment while the send is in flight.
    await act(async () => latest!.toggleSelection("attachment-2"));

    await act(async () => latest!.handleOutboundExternalContextSent({ externalContextRefs: frozen }));
    expect(latest!.selectedAttachmentIds).toEqual(["attachment-2"]);

    // A failed/aborted send never calls the consumer, so selection is retained by construction;
    // an item without refs is a no-op.
    await act(async () => latest!.handleOutboundExternalContextSent({}));
    expect(latest!.selectedAttachmentIds).toEqual(["attachment-2"]);
    renderer.unmount();
  });

  it("keeps mutations fail-closed while neither the list response nor the host supplies an incarnation", async () => {
    apiMocks.fetchExternalSessionAttachments.mockResolvedValue(listResponse([attachment("attachment-1")]));
    const renderer = await renderHarness();

    expect(latest!.canMutate).toBe(false);
    expect(latest!.sessionIncarnationId).toBeNull();
    const attached = await latest!.attach({ sourceId: "source-1", importId: "import-1", itemId: "item-9" });
    const detached = await latest!.detach("attachment-1");
    const requested = await latest!.requestKnowledgeSnapshot("attachment-1");
    expect(attached).toBe(false);
    expect(detached).toBe(false);
    expect(requested).toBe(false);
    expect(apiMocks.attachExternalSourceToSession).not.toHaveBeenCalled();
    expect(apiMocks.detachExternalSourceAttachment).not.toHaveBeenCalled();
    expect(apiMocks.requestExternalSourceKnowledgeSnapshot).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("activates mutations from the C4 list-carried incarnation and sends the exact fetched value", async () => {
    apiMocks.fetchExternalSessionAttachments.mockResolvedValue(
      listResponse([attachment("attachment-1")], "incarnation-from-list-1"),
    );
    apiMocks.attachExternalSourceToSession.mockResolvedValue({ disposition: "created" });
    apiMocks.detachExternalSourceAttachment.mockResolvedValue({ disposition: "detached" });
    const renderer = await renderHarness();

    // No host seam at all — the durable reload alone activates mutations.
    expect(latest!.canMutate).toBe(true);
    expect(latest!.sessionIncarnationId).toBe("incarnation-from-list-1");

    await act(async () => {
      await latest!.attach({ sourceId: "source-1", importId: "import-1", itemId: "item-9" });
    });
    expect(apiMocks.attachExternalSourceToSession).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSessionIncarnationId: "incarnation-from-list-1" }),
    );
    await act(async () => {
      await latest!.detach("attachment-1");
    });
    expect(apiMocks.detachExternalSourceAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSessionIncarnationId: "incarnation-from-list-1" }),
    );
    renderer.unmount();
  });

  it("tracks the freshest list-carried incarnation and prefers it over the host seam", async () => {
    apiMocks.fetchExternalSessionAttachments.mockResolvedValueOnce(
      listResponse([attachment("attachment-1")], "incarnation-server-1"),
    );
    apiMocks.attachExternalSourceToSession.mockResolvedValue({ disposition: "created" });
    // The host seam supplies a stale value; the server-carried one must win.
    const renderer = await renderHarness({ sessionIncarnationId: "incarnation-host-stale" });
    expect(latest!.sessionIncarnationId).toBe("incarnation-server-1");

    // A reload observing a NEW incarnation (e.g. session reactivation) updates
    // the CAS value for every later mutation.
    apiMocks.fetchExternalSessionAttachments.mockResolvedValue(
      listResponse([attachment("attachment-1")], "incarnation-server-2"),
    );
    await act(async () => {
      await latest!.reload();
    });
    expect(latest!.sessionIncarnationId).toBe("incarnation-server-2");
    await act(async () => {
      await latest!.attach({ sourceId: "source-1", importId: "import-1", itemId: "item-9" });
    });
    expect(apiMocks.attachExternalSourceToSession).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSessionIncarnationId: "incarnation-server-2" }),
    );
    renderer.unmount();
  });

  it("attaches, detaches, and requests a knowledge copy with exact C1 inputs, then reloads", async () => {
    apiMocks.fetchExternalSessionAttachments.mockResolvedValue(listResponse([attachment("attachment-1")]));
    apiMocks.attachExternalSourceToSession.mockResolvedValue({ disposition: "created" });
    apiMocks.detachExternalSourceAttachment.mockResolvedValue({ disposition: "detached" });
    apiMocks.requestExternalSourceKnowledgeSnapshot.mockResolvedValue({ approvalId: "approval-12345678" });
    const renderer = await renderHarness({ sessionIncarnationId: "incarnation-1" });
    expect(latest!.canMutate).toBe(true);

    await act(async () => {
      await latest!.attach({ sourceId: "source-1", importId: "import-1", itemId: "item-9" });
    });
    expect(apiMocks.attachExternalSourceToSession).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      expectedSessionIncarnationId: "incarnation-1",
      sourceId: "source-1",
      importId: "import-1",
      itemId: "item-9",
    });

    await act(async () => {
      await latest!.detach("attachment-1");
    });
    expect(apiMocks.detachExternalSourceAttachment).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attachmentId: "attachment-1",
      expectedRevision: 1,
      expectedSessionIncarnationId: "incarnation-1",
    });

    await act(async () => {
      await latest!.requestKnowledgeSnapshot("attachment-1");
    });
    expect(apiMocks.requestExternalSourceKnowledgeSnapshot).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      expectedSessionIncarnationId: "incarnation-1",
      attachmentId: "attachment-1",
      importId: "import-1",
      itemId: "item-attachment-1",
      expectedAttachmentRevision: 1,
    });
    // Identifier-only guarantee: no hash key ever leaves the hook.
    for (const call of apiMocks.requestExternalSourceKnowledgeSnapshot.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/[0-9a-f]{64}/u);
    }
    // Initial load + one reload per successful mutation.
    expect(apiMocks.fetchExternalSessionAttachments).toHaveBeenCalledTimes(4);
    expect(pushLocalNotice).toHaveBeenCalledWith(expect.stringContaining("approvals inbox"), "success");
    renderer.unmount();
  });

  it("drops a selection whose attachment detached on reload", async () => {
    apiMocks.fetchExternalSessionAttachments.mockResolvedValueOnce(
      listResponse([attachment("attachment-1"), attachment("attachment-2")]),
    );
    const renderer = await renderHarness();
    await act(async () => latest!.toggleSelection("attachment-1"));
    await act(async () => latest!.toggleSelection("attachment-2"));

    apiMocks.fetchExternalSessionAttachments.mockResolvedValueOnce(listResponse([attachment("attachment-2")]));
    await act(async () => {
      await latest!.reload();
    });
    expect(latest!.selectedAttachmentIds).toEqual(["attachment-2"]);
    expect(latest!.captureOutboundExternalContextRefs()).toEqual([
      { kind: "external_attachment", ref: "attachment-2", label: "External item-attachment-2" },
    ]);
    renderer.unmount();
  });
});
