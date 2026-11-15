// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopUpdateStatus } from "@goatcitadel/contracts";
import { formatBytes } from "@goatcitadel/mission-control-shared/content/format";
import { DesktopUpdateSettings } from "./DesktopUpdateSettings";

const host = vi.hoisted(() => ({ status: null as DesktopUpdateStatus | null }));
vi.mock("../../../features/desktop-updates/desktop-update-bridge", () => ({ useDesktopUpdates: () => host.status }));
vi.mock("../../../features/desktop-updates/use-desktop-update-actions", () => ({
  useDesktopUpdateActions: () => ({ act: vi.fn(), busy: false, uncertain: false }),
}));
let root: Root, element: HTMLDivElement;
beforeEach(() => {
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

it("U-ST-015: keeps build hashes out of the text and formats sizes with the shared formatter", async () => {
  host.status = {
    channel: "stable",
    phase: "downloading",
    installedVersion: "1.4.0",
    installedCommit: "0a1b2c3d4e5f60718293",
    message: "Downloading",
    downloadedBytes: 5242880,
    downloadedPath: null,
    nextCheckAt: null,
    snoozedUntil: null,
    lastSuccessfulCheck: null,
    availableRelease: {
      version: "1.5.0",
      sourceCommit: "f9e8d7c6b5a4938271aa",
      buildSequence: 3,
      tag: "v1.5.0",
      channel: "stable",
      publishedAt: "2026-11-01T00:00:00Z",
      releaseNotes: "",
      installer: { name: "setup.exe", url: "https://example.invalid/setup.exe", sizeBytes: 20971520, sha256: "x" },
      publisherSigned: true,
    },
  };
  await act(async () => root.render(<DesktopUpdateSettings />));
  const visible = element.textContent ?? "";
  expect(visible).toContain("Installed: 1.4.0");
  expect(visible).toContain("Available: 1.5.0");
  expect(visible).not.toMatch(/0a1b2c3d|f9e8d7c6/);
  expect(visible).toContain(`Downloading ${formatBytes(5242880)} of ${formatBytes(20971520)}`);
  expect(visible).not.toMatch(/Downloading \d+ of \d+ MB/);
});
