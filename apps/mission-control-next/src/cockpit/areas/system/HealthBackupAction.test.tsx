// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { HealthBackupAction } from "./HealthBackupAction";
import { __resetBackupAttemptsForTests } from "./health-backup-action";
const api = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), access: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({ createBackup: api.create, listBackups: api.list }));
vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({ fetchGatewayCurrentAccess: api.access }));
// Exercise action lifecycle; Radix/access-bound dialog behavior is covered by the shared owner tests.
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null }));
const manifest = { backupId: "backup-test", createdAt: "2026-10-06T00:00:00Z", appVersion: "1.0", rootDir: "test", files: [{ path: "data/index.db", sizeBytes: 10, sha256: "a".repeat(64) }] };
const receipt = { backupId: manifest.backupId, bytes: 10, outputPath: "fixture/backups/test", manifest };
let container: HTMLDivElement, root: Root;
beforeEach(() => { vi.resetAllMocks(); __resetBackupAttemptsForTests(); api.access.mockResolvedValue({ operatorAccess: true }); api.list.mockResolvedValue({ items: [] }); api.create.mockResolvedValue(receipt); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const click = async (label: string) => { const button = [...container.querySelectorAll("button")].find(node => node.textContent === label)!; expect(button).toBeDefined(); await act(async () => button.click()); };
const render = async () => { await act(async () => root.render(<HealthBackupAction />)); };
it("shows governed scope, Cancel sends nothing, pending blocks duplicates, canonical receipt preserves verification boundary", async () => {
  await render(); await click("Back up now"); expect(container.textContent).toContain("All workspaces");
  await click("Cancel"); expect(api.create).not.toHaveBeenCalled();
  await click("Back up now");
  let finish!: (value: typeof receipt) => void;
  api.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await click("Confirm backup");
  expect(container.textContent).toContain("Creating backup on the Gateway host");
  expect([...container.querySelectorAll("button")].find(node => node.textContent === "Creating backup…")?.disabled).toBe(true);
  api.list.mockResolvedValue({ items: [manifest] }); await act(async () => finish(receipt));
  expect(api.create).toHaveBeenCalledOnce(); expect(container.querySelector('[aria-label="Backup creation receipt"]')?.textContent).toContain("10 bytes");
  expect(container.textContent).toContain("have not been verified"); expect(container.textContent).toContain("offline restore or installed-host readiness");
});
it("announces unknown outcome without an invented receipt and keeps duplicate guard across remount", async () => {
  api.create.mockRejectedValue(new Error("HTTP 503"));
  await render(); await click("Back up now"); await click("Confirm backup");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("outcome is unconfirmed");
  expect(container.querySelector('[aria-label="Backup creation receipt"]')).toBeNull();
  await act(async () => root.render(null)); await render();
  expect([...container.querySelectorAll("button")].find(node => node.textContent === "Back up now")?.disabled).toBe(true);
  expect(api.create).toHaveBeenCalledOnce();
});
it("withholds creation while the current health-owner read is unavailable", async () => {
  await act(async () => root.render(<HealthBackupAction readAvailable={false} />));
  expect([...container.querySelectorAll("button")].find(node => node.textContent === "Back up now")?.disabled).toBe(true);
  await click("Back up now"); expect(api.access).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Creation requires a current read");
});
