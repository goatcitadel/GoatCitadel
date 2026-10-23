// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeRecordSections } from "./RuntimeRecordSections";
import { runtimeData, testDaemon } from "./runtime-page.test-data";

const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
const inbox = vi.hoisted(() => ({ value: { data: undefined as unknown, isError: false } }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("../../data/use-operator-inbox", () => ({ useOperatorInbox: () => inbox.value }));
// The backup action owns its own confirmation and receipt tests.
vi.mock("./HealthBackupAction", () => ({ HealthBackupAction: () => <button type="button">Back up now</button> }));

const latest = { backupId: "backup-0001", createdAt: "2026-10-20T08:00:00Z" };
const backup = { ...latest, appVersion: "1.0", rootDir: "x", files: [{}, {}, {}] };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  preferences.showTechnicalDetails = false;
  inbox.value = { data: undefined, isError: false };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (data = runtimeData()) =>
  act(() => root.render(<RuntimeRecordSections data={data} workspaceId="workspace-a" onRefresh={async () => {}} />));
const withBackup = (overrides: Record<string, unknown> = {}) =>
  runtimeData({
    health: { daemonStatus: testDaemon, systemVitals: {}, database: {}, backups: { latest } },
    backups: [backup],
    ...overrides,
  });
const section = (title: string) =>
  [...host.querySelectorAll("section")].find((node) => node.querySelector("h2")?.textContent === title)!;

it("reads a backup whose verification has not been read as Not verified yet, as Health does", () => {
  render(withBackup());
  const backups = section("Backups");
  expect(backups.id).toBe("ops-runtime-backups");
  expect(backups.textContent).toContain("Not verified yet");
  expect(backups.textContent).not.toContain("Verified ");
});

it("lists backups by time and file count without their IDs", () => {
  render(withBackup());
  const backups = section("Backups");
  expect(backups.textContent).toContain("3 files");
  expect(backups.textContent).not.toContain("backup-0001");
});

it("presents a disabled MCP server as Off and links to its settings", () => {
  render(runtimeData({ mcpServers: [{ serverId: "s", label: "Search", enabled: false, transport: "http" }] }));
  const integrations = section("Integrations");
  expect(integrations.id).toBe("runtime-integrations");
  expect(integrations.textContent).toContain("Off");
  const link = [...integrations.querySelectorAll("a")].find(
    (node) => node.textContent === "Open Settings › Connections",
  );
  expect(new URL(link!.href).pathname).toBe("/settings/connections");
});

it("points runtime authority and mesh capabilities at the pages that manage them", () => {
  render();
  const records = section("Runtime records and capabilities");
  const diagnostics = [...records.querySelectorAll("a")].find(
    (node) => node.textContent === "Open System › Diagnostics",
  );
  expect(new URL(diagnostics!.href).pathname).toBe("/system/diagnostics");
  const library = [...records.querySelectorAll("a")].find(
    (node) => node.textContent === "Open Library › Skills and tools",
  );
  expect(new URL(library!.href).pathname).toBe("/library");
});

it("says MCP servers could not be read when that source failed, instead of listing none", () => {
  render(runtimeData({}, ["mcpServers"]));
  expect(section("Integrations").textContent).toContain("MCP servers could not be read.");
});
