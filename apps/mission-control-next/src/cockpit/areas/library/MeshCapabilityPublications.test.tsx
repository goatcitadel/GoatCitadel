// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import type {
  MeshCapabilityOpsEntry,
  MeshCapabilityOpsManifest,
} from "@goatcitadel/mission-control-shared/api/mesh-capabilities";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { MeshCapabilityPublications } from "./MeshCapabilityPublications";

const MANIFEST = "a".repeat(64);
const ENTRY = "b".repeat(64);
const entry = (overrides: Partial<MeshCapabilityOpsEntry> = {}): MeshCapabilityOpsEntry => ({
  nodeId: "node-1",
  admissionGeneration: 2,
  publisherGeneration: 3,
  manifestSha256: MANIFEST,
  entrySha256: ENTRY,
  localId: "search",
  capabilityKind: "tool",
  status: "review_required",
  reasons: ["operator_review_required"],
  effectPosture: "read_only",
  ...overrides,
});
const manifest = (entries: MeshCapabilityOpsEntry[]): MeshCapabilityOpsManifest => ({
  publicationKey: "pub-1",
  manifestSha256: MANIFEST,
  admissionGeneration: 2,
  publisherGeneration: 3,
  createdAt: "2026-10-08T10:00:00.000Z",
  entries,
});
const inspection = (entries: MeshCapabilityOpsEntry[]) => ({
  workspaceId: "default",
  generatedAt: "2026-10-08T10:00:00.000Z",
  manifests: [manifest(entries)],
});

const ops = vi.hoisted(() => ({
  value: {
    inspection: null as unknown,
    invocationActivity: [] as unknown[],
    loading: false,
    error: null as string | null,
    activityError: null as string | null,
    reload: vi.fn(async () => undefined),
  },
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMeshCapabilityOps", () => ({
  useMeshCapabilityOps: vi.fn(() => ops.value),
}));
const api = vi.hoisted(() => ({
  fetchMeshCapabilityPublications: vi.fn(),
  requestMeshCapabilityActivation: vi.fn(),
  revokeMeshCapabilityActivation: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/mesh-capabilities", () => api);
const approvals = vi.hoisted(() => ({ fetchApprovals: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => approvals);
const pendingMeshApproval = (capabilityId: string, workspaceId = "default") => ({
  approvalId: "ap-pending",
  kind: "mesh.capability.activate",
  status: "pending",
  payload: { capabilityId, workspaceId },
});
let modal: ComponentProps<typeof ConfirmModal> | undefined;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    if (props.open) modal = props;
    return props.open ? <div role="dialog">{props.message}</div> : null;
  },
}));

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <CockpitNavigationProvider>
        <MeshCapabilityPublications workspaceId="default" />
      </CockpitNavigationProvider>,
    ),
  );
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const click = (label: string) => act(async () => button(label)!.click());
const confirm = () => act(async () => modal!.onConfirm());
async function type(label: string, value: string) {
  const input = [...container.querySelectorAll("input")].find((item) =>
    item.closest("label")?.textContent?.includes(label),
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  modal = undefined;
  approvals.fetchApprovals.mockResolvedValue({ items: [] });
  ops.value = {
    inspection: null,
    invocationActivity: [],
    loading: false,
    error: null,
    activityError: null,
    reload: vi.fn(async () => undefined),
  };
  api.requestMeshCapabilityActivation.mockResolvedValue({
    replayed: false,
    activationId: "act-1",
    activationRevision: 1,
    approvalId: "ap-1",
    approvalStatus: "pending",
    approvalExpiresAt: "2026-10-08T10:15:00.000Z",
    diff: {
      permissionDisposition: "initial",
      permissionsAdded: ["read"],
      permissionsRemoved: [],
      effectDisposition: "initial",
      currentEffectPosture: "read_only",
    },
  });
  api.revokeMeshCapabilityActivation.mockResolvedValue({
    replayed: false,
    activationId: "act-1",
    reason: "No longer needed",
    revokedAt: "2026-10-08T10:20:00.000Z",
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("cockpit mesh capability publications", () => {
  it("shows manifests and entries with digests, status, effects and reasons, without acting", async () => {
    ops.value.inspection = inspection([entry()]);
    await render();
    const manifests = container.querySelector('[aria-label="Published mesh capability manifests"]')!;
    expect(manifests.textContent).toContain("Node node-1");
    expect(manifests.textContent).toContain("Publisher generation 3");
    expect(manifests.textContent).toContain(`sha256:${MANIFEST.slice(0, 12)}…`);
    expect(manifests.textContent).toContain("search");
    expect(manifests.textContent).toContain("Review required");
    expect(manifests.textContent).toContain("Inspect only");
    expect(manifests.textContent).toContain("Effects: read only");
    expect(manifests.textContent).toContain("Awaiting operator review; publication alone never grants callability.");
    expect(manifests.textContent).toContain("mesh:node-1:tool:search");
    expect(api.requestMeshCapabilityActivation).not.toHaveBeenCalled();
  });

  it("requests activation of the exact entry only after review and a fresh re-read", async () => {
    ops.value.inspection = inspection([entry()]);
    api.fetchMeshCapabilityPublications.mockResolvedValue(inspection([entry()]));
    await render();
    await click("Review activation request");
    expect(api.requestMeshCapabilityActivation).not.toHaveBeenCalled();
    expect(modal?.message).toContain("Nothing becomes callable until that approval is decided.");
    await confirm();
    expect(api.fetchMeshCapabilityPublications).toHaveBeenCalledWith("default");
    expect(api.requestMeshCapabilityActivation).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      capabilityId: "mesh:node-1:tool:search",
      manifestSha256: MANIFEST,
      entrySha256: ENTRY,
    });
    const receipt = container.querySelector('[aria-label="Activation request receipt"]')!;
    expect(receipt.textContent).toContain("search: approval is pending");
    expect(receipt.textContent).toContain("Permissions initial (1 added, 0 removed)");
    expect([...receipt.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(
      expect.arrayContaining([expect.stringContaining("/inbox?approvalId=ap-1")]),
    );
    expect(ops.value.reload).toHaveBeenCalled();
  });

  it("sends nothing when the entry changed since the review", async () => {
    ops.value.inspection = inspection([entry()]);
    api.fetchMeshCapabilityPublications.mockResolvedValue(inspection([entry({ entrySha256: "c".repeat(64) })]));
    await render();
    await click("Review activation request");
    await confirm();
    expect(api.requestMeshCapabilityActivation).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "This entry changed since your review, so nothing was sent. Review the current publication.",
    );
  });

  it("never offers activation for a skill descriptor", async () => {
    ops.value.inspection = inspection([entry({ capabilityKind: "skill" })]);
    await render();
    expect(button("Review activation request")).toBeUndefined();
    expect(container.textContent).toContain("Skill descriptors are review-only");
  });

  it("revokes an activation only with a reason, after review and re-read", async () => {
    const active = entry({
      status: "active",
      reasons: ["activation_live"],
      activation: { activationId: "act-1", activationRevision: 1, approvalId: "ap-1", revoked: false },
    });
    ops.value.inspection = inspection([active]);
    api.fetchMeshCapabilityPublications.mockResolvedValue(inspection([active]));
    await render();
    expect(container.textContent).toContain("Callable");
    expect(button("Review revoke")!.disabled).toBe(true);
    await type("Revocation reason", "No longer needed");
    await click("Review revoke");
    expect(modal?.message).toContain("Reason: No longer needed");
    await confirm();
    expect(api.revokeMeshCapabilityActivation).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      activationId: "act-1",
      reason: "No longer needed",
    });
    expect(container.textContent).toContain("The activation was revoked. Publications were read again.");
  });

  it("retries a lost request only after a fresh re-read finds the entry unchanged", async () => {
    ops.value.inspection = inspection([entry()]);
    api.fetchMeshCapabilityPublications.mockResolvedValue(inspection([entry()]));
    api.requestMeshCapabilityActivation.mockRejectedValueOnce(new Error("Failed to fetch"));
    await render();
    await click("Review activation request");
    await confirm();
    expect(container.textContent).toContain(
      "The outcome is unknown. Publications were read again. Retry re-reads the publication first and sends the same request only if this entry is unchanged.",
    );
    await click("Retry the same request");
    expect(api.fetchMeshCapabilityPublications).toHaveBeenCalledTimes(2);
    expect(api.requestMeshCapabilityActivation).toHaveBeenCalledTimes(2);
    expect(api.requestMeshCapabilityActivation.mock.calls[1]).toEqual(
      api.requestMeshCapabilityActivation.mock.calls[0],
    );
  });

  it("never requests again once the entry has a live activation, including on retry", async () => {
    ops.value.inspection = inspection([entry()]);
    api.fetchMeshCapabilityPublications.mockResolvedValueOnce(inspection([entry()]));
    api.requestMeshCapabilityActivation.mockRejectedValueOnce(new Error("Failed to fetch"));
    await render();
    await click("Review activation request");
    await confirm();
    api.fetchMeshCapabilityPublications.mockResolvedValue(
      inspection([
        entry({ activation: { activationId: "act-1", activationRevision: 1, approvalId: "ap-1", revoked: false } }),
      ]),
    );
    await click("Retry the same request");
    expect(api.requestMeshCapabilityActivation).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "This entry changed since your review, so nothing was sent. Review the current publication.",
    );
  });

  it("reports a definitive Gateway refusal as nothing created, with no retry", async () => {
    ops.value.inspection = inspection([entry()]);
    api.fetchMeshCapabilityPublications.mockResolvedValue(inspection([entry()]));
    api.requestMeshCapabilityActivation.mockRejectedValueOnce(
      new ApiRequestError("refused", {
        kind: "http",
        method: "POST",
        path: "/api/v1/mesh/capabilities/activations",
        status: 409,
      }),
    );
    await render();
    await click("Review activation request");
    await confirm();
    expect(container.textContent).toContain(
      "The Gateway refused this request, so nothing was changed. Review the current publication.",
    );
    expect(button("Retry the same request")).toBeUndefined();
  });

  it("shows an unrecognized Gateway value as itself instead of failing", async () => {
    ops.value.inspection = inspection([
      entry({ status: "quarantined" as never, capabilityKind: "workflow" as never, effectPosture: "network" as never }),
    ]);
    await render();
    const manifests = container.querySelector('[aria-label="Published mesh capability manifests"]')!;
    expect(manifests.textContent).toContain("quarantined");
    expect(manifests.textContent).toContain("workflow");
    expect(manifests.textContent).toContain("Effects: network");
    expect(manifests.textContent).not.toContain("undefined");
    expect(container.querySelector("h3")?.textContent).toContain("Node node-1");
    expect(container.querySelector("li h4")?.textContent).toBe("search");
  });

  it("does not request activation while an approval for the same capability is pending", async () => {
    ops.value.inspection = inspection([entry()]);
    api.fetchMeshCapabilityPublications.mockResolvedValue(inspection([entry()]));
    approvals.fetchApprovals
      .mockResolvedValueOnce({ items: [pendingMeshApproval("mesh:node-1:tool:other")], nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [pendingMeshApproval("mesh:node-1:tool:search")] });
    await render();
    await click("Review activation request");
    await confirm();
    expect(approvals.fetchApprovals).toHaveBeenNthCalledWith(1, {
      status: "pending",
      workspaceId: "default",
      limit: 200,
    });
    expect(approvals.fetchApprovals).toHaveBeenNthCalledWith(2, {
      status: "pending",
      workspaceId: "default",
      limit: 200,
      cursor: "page-2",
    });
    expect(api.requestMeshCapabilityActivation).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "An activation approval for this capability is already pending, so nothing was sent.",
    );
    const link = [...container.querySelectorAll("a")].find(
      (item) => item.textContent === "Open the pending activation approval",
    );
    expect(link?.getAttribute("href")).toContain("/inbox?approvalId=ap-pending");
  });

  it("sends nothing when pending approvals cannot be fully checked", async () => {
    ops.value.inspection = inspection([entry()]);
    api.fetchMeshCapabilityPublications.mockResolvedValue(inspection([entry()]));
    approvals.fetchApprovals.mockRejectedValueOnce(new Error("unavailable"));
    await render();
    await click("Review activation request");
    await confirm();
    expect(api.requestMeshCapabilityActivation).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Pending approvals could not be checked, so nothing was sent.");
  });

  it("shows invocation outcomes read-only and flags manual reconciliation", async () => {
    ops.value.inspection = inspection([]);
    ops.value.invocationActivity = [
      {
        invocationId: "inv-1",
        capabilityId: "mesh:node-1:tool:search",
        nodeId: "node-1",
        phase: "settled",
        disposition: "unknown",
        settlementAuthority: "gateway",
        manualReconciliationRequired: true,
        observedAt: "2026-10-08T10:05:00.000Z",
      },
    ];
    await render();
    const outcomes = container.querySelector('[aria-label="Mesh invocation outcomes"]')!;
    expect(outcomes.textContent).toContain(
      "1 invocation settled with an unknown delivery and awaits manual reconciliation.",
    );
    expect(outcomes.textContent).toContain("Manual reconciliation required");
    expect(outcomes.querySelectorAll("button")).toHaveLength(0);
  });

  it("states unavailable publications without inventing entries", async () => {
    ops.value.error = "The mesh capability publication inspection is unavailable.";
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The mesh capability publication inspection is unavailable.",
    );
    expect(container.querySelector('[aria-label="Published mesh capability manifests"]')).toBeNull();
  });
});
