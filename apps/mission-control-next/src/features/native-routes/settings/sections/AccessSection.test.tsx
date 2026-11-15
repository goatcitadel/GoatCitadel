// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccessSection } from "./AccessSection";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchDaemonStatus: vi.fn(),
  fetchDeviceAccessGrants: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
vi.mock("../GatewayAuthEditor", () => ({ GatewayAuthEditor: () => null }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network in Access fixture");
    }),
  );
  api.fetchSettings.mockResolvedValue({ auth: { mode: "none" } });
  api.fetchDaemonStatus.mockResolvedValue({ state: "running", running: true, host: "fixture" });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function renderAccess() {
  await act(async () =>
    root.render(
      <AccessSection
        route={{ area: "settings", section: "access", theme: "light" }}
        section="access"
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    ),
  );
}

function stat(label: string) {
  return [...container.querySelectorAll(".mc-next-directory-stats > div")]
    .find((item) => item.querySelector("span")?.textContent === label)
    ?.querySelector("strong")?.textContent;
}

it("reports unavailable device counts after a failed read and recovers on retry", async () => {
  const grant = {
    grantId: "fixture",
    requestId: "request-fixture",
    actorId: "actor-fixture",
    deviceLabel: "Fixture phone",
    deviceType: "mobile",
    createdAt: "2026-11-01T00:00:00Z",
    metadata: {},
  };
  api.fetchDeviceAccessGrants
    .mockRejectedValueOnce(new Error("Device read failed"))
    .mockResolvedValueOnce({ items: [grant, { ...grant, grantId: "revoked", revokedAt: "2026-11-02T00:00:00Z" }] });

  await renderAccess();
  expect(container.textContent).toContain("Device read failed");
  expect(stat("Desktop")).toBe("running");
  expect(stat("Active devices")).toBe("Unavailable");
  expect(stat("Grants")).toBe("Unavailable");
  expect(container.textContent).not.toContain("No device grants found.");
  expect(container.textContent).not.toContain("No mobile grant");
  expect(container.textContent).not.toContain("Local only");

  const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry");
  expect(retry).toBeDefined();
  await act(async () => retry?.click());
  expect(stat("Active devices")).toBe("1");
  expect(stat("Grants")).toBe("2");
  expect(container.textContent).toContain("Fixture phone");
  expect(container.textContent).not.toContain("Device read failed");
});

it("shows confirmed zero counts for a successful empty read even if daemon status fails", async () => {
  api.fetchDeviceAccessGrants.mockResolvedValue({ items: [] });
  api.fetchDaemonStatus.mockRejectedValue(new Error("Daemon read failed"));
  await renderAccess();
  expect(container.textContent).toContain("Daemon read failed");
  expect(stat("Active devices")).toBe("0");
  expect(stat("Grants")).toBe("0");
  expect(container.textContent).toContain("No device grants found.");
});
