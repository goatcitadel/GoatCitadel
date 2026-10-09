// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { SessionControlManager } from "./SessionControlManager";

const NOW = "2026-07-14T12:00:00.000Z";
const operator = (generation = 1) => ({
  workspaceId: "workspace-a",
  sessionId: "session-a",
  generation,
  ownerKind: "operator" as const,
  leaseState: "operator_active" as const,
  capabilities: [] as const,
  lastEventId: "event-operator",
  lastEventReasonCode: "session_initialized" as const,
  updatedAt: NOW,
});
const external = (generation = 2, leaseState: "external_live" | "external_stale" = "external_live") => ({
  workspaceId: "workspace-a",
  sessionId: "session-a",
  generation,
  ownerKind: "external_companion" as const,
  leaseState,
  capabilities: ["send", "read"] as const,
  boundExternalController: {
    companionSessionId: "companion-a",
    clientInstanceId: "client-a",
    principalPurpose: "session_control_client" as const,
    tokenFingerprint: "aaaaaaaa",
  },
  lastHeartbeatAt: NOW,
  leaseExpiresAt: "2026-07-14T12:01:00.000Z",
  reconnectExpiresAt: "2026-07-14T12:05:00.000Z",
  lastEventId: "event-external",
  lastEventReasonCode: "handoff" as const,
  updatedAt: NOW,
});
const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: "request-a",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  companionSessionId: "companion-a",
  clientInstanceId: "client-a",
  tokenFingerprint: "aaaaaaaa",
  requestedCapabilities: ["send", "read"] as const,
  requestedGeneration: 1,
  idempotencyKey: "request-idempotency-a",
  expiresAt: "2026-07-14T12:15:00.000Z",
  createdAt: NOW,
  status: "pending" as const,
  ...overrides,
});

const status = vi.hoisted(() => ({
  value: { data: null as unknown, loading: false, error: null as string | null, reload: vi.fn(async () => undefined) },
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useSessionControlStatus", () => ({
  useSessionControlStatus: vi.fn(() => status.value),
}));
const api = vi.hoisted(() => ({
  fetchSessionControlDetail: vi.fn(),
  handoffSessionControl: vi.fn(),
  revokeSessionControl: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/session-control-operator", () => api);
let modal: ComponentProps<typeof ConfirmModal> | undefined;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    if (props.open) modal = props;
    return props.open ? <div role="dialog">{props.message}</div> : null;
  },
}));

let root: Root;
let container: HTMLDivElement;
const render = () => act(async () => root.render(<SessionControlManager sessionId="session-a" />));
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const click = (label: string) => act(async () => button(label)!.click());
const confirm = () => act(async () => modal!.onConfirm());

beforeEach(() => {
  modal = undefined;
  status.value = { data: null, loading: false, error: null, reload: vi.fn(async () => undefined) };
  api.handoffSessionControl.mockResolvedValue({});
  api.revokeSessionControl.mockResolvedValue({});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("cockpit session control", () => {
  it("shows operator ownership and pending requests without acting", async () => {
    status.value.data = { control: operator(), pendingRequests: [request()] };
    await render();
    expect(container.textContent).toContain("You control this conversation · Generation 1");
    const pending = container.querySelector('[aria-label="Pending control requests"]')!;
    expect(pending.textContent).toContain("client-a");
    expect(pending.textContent).toContain("Requested: Send and Read");
    expect(pending.textContent).toContain("…aaaaaaaa");
    expect(api.handoffSessionControl).not.toHaveBeenCalled();
    expect(api.revokeSessionControl).not.toHaveBeenCalled();
  });

  it("hands off only after review and a fresh re-read at the reviewed generation", async () => {
    status.value.data = { control: operator(), pendingRequests: [request()] };
    api.fetchSessionControlDetail.mockResolvedValue({ control: operator(), pendingRequests: [request()] });
    await render();
    await act(async () => {
      const read = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      read.click();
    });
    await click("Review handoff");
    expect(api.handoffSessionControl).not.toHaveBeenCalled();
    expect(modal?.message).toContain("Give control of this conversation to client-a with Send and Read.");
    expect(modal?.message).toContain("Your own messages stay blocked until you revoke or take over.");
    await confirm();
    expect(api.fetchSessionControlDetail).toHaveBeenCalledWith("session-a");
    expect(api.handoffSessionControl).toHaveBeenCalledExactlyOnceWith("session-a", {
      requestId: "request-a",
      expectedGeneration: 1,
      effectiveCapabilities: ["send", "read"],
      idempotencyKey: expect.stringMatching(/^op-ctl-/),
    });
    expect(status.value.reload).toHaveBeenCalled();
    expect(container.textContent).toContain("Control was handed off. The current state was read again.");
  });

  it("grants send only unless read is explicitly added", async () => {
    status.value.data = { control: operator(), pendingRequests: [request()] };
    api.fetchSessionControlDetail.mockResolvedValue({ control: operator(), pendingRequests: [request()] });
    await render();
    await click("Review handoff");
    expect(modal?.message).toContain("with Send only.");
    await confirm();
    expect(api.handoffSessionControl.mock.calls[0]![1].effectiveCapabilities).toEqual(["send"]);
  });

  it("sends nothing when control changed since the review", async () => {
    status.value.data = { control: operator(), pendingRequests: [request()] };
    api.fetchSessionControlDetail.mockResolvedValue({ control: operator(2), pendingRequests: [] });
    await render();
    await click("Review handoff");
    await confirm();
    expect(api.handoffSessionControl).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Control of this conversation changed since your review, so nothing was sent. Review the current state.",
    );
    expect(status.value.reload).toHaveBeenCalled();
  });

  it("revokes and takes over an external controller only at the reviewed generation", async () => {
    status.value.data = { control: external(), pendingRequests: [] };
    api.fetchSessionControlDetail.mockResolvedValue({ control: external(), pendingRequests: [] });
    await render();
    const controller = container.querySelector('[aria-label="Current external controller"]')!;
    expect(controller.textContent).toContain("client-a");
    expect(controller.textContent).toContain("Live lease");
    expect(controller.textContent).toContain("Send + Read");
    await click("Review revoke");
    expect(modal?.message).toContain("End client-a's control (generation 2).");
    await confirm();
    expect(api.revokeSessionControl).toHaveBeenCalledExactlyOnceWith("session-a", {
      target: "current_controller",
      expectedGeneration: 2,
      mode: "revoke",
      idempotencyKey: expect.stringMatching(/^op-ctl-/),
    });
    await click("Review emergency takeover");
    expect(modal?.title).toBe("Take over this conversation now?");
    expect(modal?.message).toContain("loses control immediately");
    await confirm();
    expect(api.revokeSessionControl.mock.calls[1]![1]).toMatchObject({
      mode: "emergency_takeover",
      expectedGeneration: 2,
    });
  });

  it("offers an identical retry after a lost response, reusing the same request key", async () => {
    status.value.data = { control: external(), pendingRequests: [] };
    api.fetchSessionControlDetail.mockResolvedValue({ control: external(), pendingRequests: [] });
    api.revokeSessionControl.mockRejectedValueOnce(new Error("Failed to fetch"));
    await render();
    await click("Review revoke");
    await confirm();
    expect(container.textContent).toContain(
      "The outcome is unknown. The current state was read again. Retry sends the identical request, which the Gateway applies at most once.",
    );
    const firstKey = api.revokeSessionControl.mock.calls[0]![1].idempotencyKey;
    await click("Retry the same request");
    expect(api.revokeSessionControl).toHaveBeenCalledTimes(2);
    expect(api.revokeSessionControl.mock.calls[1]![1].idempotencyKey).toBe(firstKey);
    expect(button("Retry the same request")).toBeUndefined();
  });

  it("reports a Gateway conflict as nothing applied and offers no retry", async () => {
    status.value.data = { control: external(), pendingRequests: [] };
    api.fetchSessionControlDetail.mockResolvedValue({ control: external(), pendingRequests: [] });
    api.revokeSessionControl.mockRejectedValueOnce(
      new ApiRequestError("conflict", {
        kind: "http",
        method: "POST",
        path: "/api/v1/chat/sessions/session-a/control/revoke",
        status: 409,
        body: { code: "SESSION_CONTROL_GENERATION_STALE" },
      }),
    );
    await render();
    await click("Review revoke");
    await confirm();
    expect(container.textContent).toContain(
      "The Gateway refused this because control changed, so nothing was applied. Review the current state.",
    );
    expect(button("Retry the same request")).toBeUndefined();
  });

  it("offers no revoke or takeover without a known generation, and never shows a missing fingerprint", async () => {
    const control = {
      ...external(),
      boundExternalController: { ...external().boundExternalController, tokenFingerprint: "" },
    };
    status.value.data = { control, pendingRequests: [] };
    await render();
    expect(container.textContent).toContain("Token fingerprint: Not reported");
    expect(container.textContent).not.toContain("…null");
    expect(container.querySelector('[role="group"][aria-label="Current external controller"]')).not.toBeNull();
  });

  it("names each request's actions after its client", async () => {
    status.value.data = {
      control: operator(),
      pendingRequests: [request(), request({ requestId: "request-b", clientInstanceId: "client-b" })],
    };
    await render();
    const labels = [...container.querySelectorAll("button")].map((item) => item.getAttribute("aria-label"));
    expect(labels).toEqual(
      expect.arrayContaining([
        "Review handoff to client-a",
        "Reject request from client-a",
        "Review handoff to client-b",
        "Reject request from client-b",
      ]),
    );
  });

  it("rejects a pending request without a confirmation", async () => {
    status.value.data = { control: operator(), pendingRequests: [request()] };
    await render();
    await click("Reject request");
    expect(api.revokeSessionControl).toHaveBeenCalledExactlyOnceWith("session-a", {
      target: "request",
      requestId: "request-a",
      idempotencyKey: expect.stringMatching(/^op-ctl-/),
    });
  });

  it("states an unavailable status without offering actions", async () => {
    status.value.error = "Session control status is unavailable.";
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Session control status is unavailable.");
    expect(button("Review revoke")).toBeUndefined();
    expect(button("Review handoff")).toBeUndefined();
  });
});
