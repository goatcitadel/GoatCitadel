// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceContinuityChecks } from "./DeviceContinuityChecks";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchDeviceAccessGrants: vi.fn(),
  fetchDaemonStatus: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const render = () =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DeviceContinuityChecks />
      </QueryClientProvider>,
    ),
  );
async function open() {
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.fetchSettings.mockResolvedValue({ auth: { mode: "token", tokenConfigured: true, basicConfigured: false } });
  api.fetchDeviceAccessGrants.mockResolvedValue({
    items: [
      { grantId: "g-1", deviceType: "mobile", deviceLabel: "Phone" },
      { grantId: "g-2", deviceType: "desktop", deviceLabel: "Laptop", revokedAt: "2026-10-01T00:00:00.000Z" },
    ],
  });
  api.fetchDaemonStatus.mockResolvedValue({ state: "running", running: true, host: "fixture-host" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("cockpit desktop and mobile continuity", () => {
  it("reads nothing until the checks are opened", async () => {
    await render();
    expect(container.querySelector("summary")?.textContent).toBe("Desktop and mobile continuity");
    expect(api.fetchSettings).not.toHaveBeenCalled();
    expect(api.fetchDeviceAccessGrants).not.toHaveBeenCalled();
    expect(api.fetchDaemonStatus).not.toHaveBeenCalled();
  });

  it("lists the read-only continuity checks from current owner evidence", async () => {
    await render();
    await open();
    const list = container.querySelector('[aria-label="Desktop and mobile continuity checks"]')!;
    expect(list.querySelectorAll("li")).toHaveLength(5);
    expect(list.textContent).toContain("Desktop runtime anchor");
    expect(list.textContent).toContain("1 active mobile/tablet device grant(s)");
    expect(list.textContent).toContain("Desktop continuity currently relies on the local session");
    expect(list.textContent).toContain("Pairable");
    expect(list.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows no checks when settings or device grants cannot be read", async () => {
    api.fetchDeviceAccessGrants.mockRejectedValue(new Error("unavailable"));
    await render();
    await open();
    expect(container.querySelector('[aria-label="Desktop and mobile continuity checks"]')).toBeNull();
    expect(container.textContent).toContain(
      "Continuity checks need the Gateway settings and device grants, which could not be read.",
    );
  });

  it("keeps the checks when only the Gateway process status is unavailable", async () => {
    api.fetchDaemonStatus.mockRejectedValue(new Error("unavailable"));
    await render();
    await open();
    const list = container.querySelector('[aria-label="Desktop and mobile continuity checks"]')!;
    expect(list.textContent).toContain("Gateway daemon status could not be loaded");
  });
});
