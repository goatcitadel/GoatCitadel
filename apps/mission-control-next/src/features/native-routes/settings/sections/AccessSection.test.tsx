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

it("keeps expired and revoked device grants in history without counting them as active", async () => {
  const grant = {
    requestId: "request-fixture",
    actorId: "actor-fixture",
    createdAt: "2026-11-01T00:00:00Z",
    metadata: {},
  };
  api.fetchDeviceAccessGrants.mockResolvedValue({
    items: [
      {
        ...grant,
        grantId: "active",
        deviceLabel: "Current phone",
        deviceType: "mobile",
        expiresAt: "2100-01-01T00:00:00Z",
      },
      {
        ...grant,
        grantId: "expired",
        deviceLabel: "Old phone",
        deviceType: "mobile",
        expiresAt: "2026-11-02T00:00:00Z",
      },
      {
        ...grant,
        grantId: "revoked",
        deviceLabel: "Revoked desktop",
        deviceType: "desktop",
        expiresAt: "2026-11-02T00:00:00Z",
        revokedAt: "2026-11-01T12:00:00Z",
      },
      {
        ...grant,
        grantId: "invalid",
        deviceLabel: "Unverified desktop",
        deviceType: "desktop",
        expiresAt: "invalid-date",
      },
    ],
  });
  await renderAccess();
  expect(stat("Active devices")).toBe("1");
  expect(stat("Grants")).toBe("4");
  expect(container.textContent).toContain("1 active mobile/tablet device grant");
  expect(container.textContent).not.toContain("active desktop device grant");
  const row = (label: string) =>
    [...container.querySelectorAll('[aria-label="Approved device grants"] .mc-next-settings-action-row')].find(
      (entry) => entry.querySelector("strong")?.textContent === label,
    );
  expect(row("Current phone")?.textContent).toContain("mobile · active");
  expect(row("Old phone")?.textContent).toContain("mobile · expired");
  expect(row("Revoked desktop")?.textContent).toContain("desktop · revoked");
  expect(row("Unverified desktop")?.textContent).toContain("desktop · unavailable");
  expect(row("Current phone")?.querySelector("button")?.textContent).toBe("Revoke");
  expect(row("Old phone")?.querySelector("button")).toBeNull();
});
