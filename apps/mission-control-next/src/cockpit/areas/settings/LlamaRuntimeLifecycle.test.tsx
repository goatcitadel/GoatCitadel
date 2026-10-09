// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlamaCppRuntimeStatus } from "@goatcitadel/contracts";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { LlamaRuntimeLifecycle } from "./LlamaRuntimeLifecycle";

const api = vi.hoisted(() => ({ refreshLlamaCppRuntime: vi.fn(), stopLlamaCppRuntime: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
let modal: ComponentProps<typeof ConfirmModal> | undefined;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    modal = props;
    return props.open ? <div role="dialog">{props.message}</div> : null;
  },
}));

function status(overrides: Partial<LlamaCppRuntimeStatus> = {}, leases = 2): LlamaCppRuntimeStatus {
  return {
    enabled: true,
    desiredState: "running",
    processState: "running",
    baseUrl: "http://127.0.0.1:8080/v1",
    pid: 4242,
    healthy: true,
    updatedAt: "2026-10-08T10:00:00.000Z",
    leaseDiagnostics: {
      state: "active",
      activeLeaseCount: leases,
      ownership: "owned",
      purposes: [{ purpose: "chat", count: leases }],
      persistentDemand: { manual: false, api: true, autostart: false },
      evidence: {
        lastProbe: { at: "2026-10-08T09:59:00.000Z", healthy: true },
        lastExit: { at: "2026-10-08T09:00:00.000Z", unexpected: true, code: 3 },
      },
    },
    ...overrides,
  };
}
let root: Root;
let container: HTMLDivElement;
const onChanged = vi.fn(async () => undefined);
const render = (props: Partial<ComponentProps<typeof LlamaRuntimeLifecycle>> = {}) =>
  act(async () =>
    root.render(
      <LlamaRuntimeLifecycle
        managementMode="managed"
        status={status()}
        busy={false}
        onChanged={onChanged}
        {...props}
      />,
    ),
  );
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const click = (label: string) => act(async () => button(label)!.click());

beforeEach(() => {
  modal = undefined;
  api.refreshLlamaCppRuntime.mockResolvedValue(status());
  api.stopLlamaCppRuntime.mockResolvedValue(
    status({ processState: "stopped", desiredState: "stopped", pid: undefined }, 0),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("cockpit llama.cpp lifecycle", () => {
  it("shows lease lifecycle evidence without running anything", async () => {
    await render();
    const lifecycle = container.querySelector('[aria-label="llama.cpp lease lifecycle"]')!;
    expect(lifecycle.textContent).toContain("Lifecycle: Active");
    expect(lifecycle.textContent).toContain("Ownership: Owned by GoatCitadel");
    expect(lifecycle.textContent).toContain("Active requests: 2 (chat 2)");
    expect(lifecycle.textContent).toContain("Kept running by: API");
    expect(lifecycle.textContent).toContain("Latest probe: healthy");
    expect(lifecycle.textContent).toContain("Latest process exit: unexpected · code 3");
    expect(api.refreshLlamaCppRuntime).not.toHaveBeenCalled();
    expect(api.stopLlamaCppRuntime).not.toHaveBeenCalled();
  });

  it("says when the Gateway does not report lifecycle diagnostics", async () => {
    await render({ status: status({ leaseDiagnostics: undefined }) });
    expect(container.textContent).toContain("This Gateway does not report llama.cpp lifecycle diagnostics.");
    expect(button("Review stop")).toBeUndefined();
  });

  it("never offers to stop an external server or a process GoatCitadel does not own", async () => {
    await render({ managementMode: "external" });
    expect(button("Review stop")).toBeUndefined();
    expect(container.textContent).toContain("Stop an external llama.cpp server through its own process manager.");
    const external = status();
    external.leaseDiagnostics!.ownership = "external";
    await render({ status: external });
    expect(button("Review stop")).toBeUndefined();
    expect(container.textContent).toContain("No GoatCitadel-owned llama.cpp process is running.");
  });

  it("re-reads the runtime before a reviewed stop and warns about active requests", async () => {
    await render();
    await click("Review stop");
    expect(modal?.open).toBe(true);
    expect(modal?.message).toContain("2 active requests are using this runtime and will be interrupted.");
    await act(async () => modal!.onConfirm());
    expect(api.refreshLlamaCppRuntime).toHaveBeenCalledOnce();
    expect(api.stopLlamaCppRuntime).toHaveBeenCalledOnce();
    expect(api.refreshLlamaCppRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      api.stopLlamaCppRuntime.mock.invocationCallOrder[0]!,
    );
    expect(onChanged).toHaveBeenCalled();
    expect(container.textContent).toContain("Stop requested. The status shown is read back from the Gateway.");
  });

  it("does not stop when more work started after the review", async () => {
    api.refreshLlamaCppRuntime.mockResolvedValue(status({}, 3));
    await render();
    await click("Review stop");
    await act(async () => modal!.onConfirm());
    expect(api.stopLlamaCppRuntime).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "The runtime changed since your review, so it was not stopped. Review it again.",
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("does not stop when the process is no longer owned", async () => {
    const released = status();
    released.leaseDiagnostics!.ownership = "none";
    api.refreshLlamaCppRuntime.mockResolvedValue(released);
    await render();
    await click("Review stop");
    await act(async () => modal!.onConfirm());
    expect(api.stopLlamaCppRuntime).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The runtime changed since your review");
  });

  it("reports an unknown stop outcome and reads the status again", async () => {
    api.stopLlamaCppRuntime.mockRejectedValue(new Error("Failed to fetch"));
    await render();
    await click("Review stop");
    await act(async () => modal!.onConfirm());
    expect(container.textContent).toContain(
      "The stop outcome is unknown. The runtime status was read again; check it before acting.",
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("refreshes runtime status as a probe only", async () => {
    await render();
    await click("Refresh runtime status");
    expect(api.refreshLlamaCppRuntime).toHaveBeenCalledOnce();
    expect(api.stopLlamaCppRuntime).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("disables lifecycle actions while another runtime change is busy", async () => {
    await render({ busy: true });
    expect(button("Review stop")!.disabled).toBe(true);
    expect(button("Refresh runtime status")!.disabled).toBe(true);
  });
});
