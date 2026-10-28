// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { FilesystemWriteRootsControl } from "./FilesystemWriteRootsControl";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));

type Root_ = { path: string; allowDelete: boolean; preset?: "os_temp"; label?: string; addedAt?: string };
function settingsAt(
  revision: number,
  overrides: { roots?: Root_[]; deny?: string[]; allow?: string[]; switchedOffToolGroups?: string[] } = {},
) {
  return {
    revision,
    writeJailRoots: ["/srv/goat/workspace", "/srv/goat/data"],
    readOnlyRoots: ["/srv/goat/skills"],
    operatorWriteRoots: overrides.roots ?? [],
    globalToolAccess: { deny: overrides.deny ?? ["fs.delete"], allow: overrides.allow ?? [] },
    ...(overrides.switchedOffToolGroups ? { switchedOffToolGroups: overrides.switchedOffToolGroups } : {}),
  };
}

let container: HTMLDivElement, root: Root, client: QueryClient;
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
const text = () => document.body.textContent ?? "";
const dialog = () => document.querySelector('[role="dialog"]');
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <FilesystemWriteRootsControl />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(text()).toContain("Operator write roots"));
}
const pathInput = () => container.querySelector<HTMLInputElement>('input[type="text"]')!;
const toolSelect = (tool: string) =>
  [...container.querySelectorAll("select")].find((select) =>
    select.closest("label")?.textContent?.includes(`Access for ${tool}`),
  )!;

beforeEach(() => {
  window.history.replaceState(null, "", "/settings/safety?shell=cockpit#filesystem-write-roots");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("cockpit filesystem write roots", () => {
  it("shows config-owned folders read-only and adds a folder against the version the operator saw", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4));
    await render();
    expect(text()).toContain("/srv/goat/workspace");
    expect(text()).toContain("/srv/goat/skills");
    expect(text()).toContain("edited in the config file");
    expect(text()).toContain("Deny-wins and approvals still apply");
    expect(text()).toContain("None yet.");
    const saved = settingsAt(5, {
      roots: [{ path: "/srv/scratch", allowDelete: false, addedAt: "2026-10-17T00:00:00Z" }],
    });
    api.patchSettings.mockResolvedValue(saved);
    await type(pathInput(), "/srv/scratch/");
    api.fetchSettings.mockResolvedValueOnce(settingsAt(4)).mockResolvedValue(saved);
    await click(button("Add folder"));
    await vi.waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({
        expectedRevision: 4,
        operatorWriteRootChange: { action: "add", path: "/srv/scratch/", allowDelete: false },
      }),
    );
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(text()).toContain("Added /srv/scratch. Delete is off in this folder."));
    await vi.waitFor(() => expect(pathInput().value).toBe(""));
    expect(text()).toContain("Delete off");
  });

  it("shows the gateway's refusal under the folder field without locking further saves", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4));
    api.patchSettings.mockRejectedValue(
      new ApiRequestError("refused", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/settings",
        status: 400,
        body: { message: "That folder holds GoatCitadel runtime files, so it cannot be a write root." },
      }),
    );
    await render();
    await type(pathInput(), "/srv/goat");
    await click(button("Add folder"));
    await vi.waitFor(() => expect(pathInput().getAttribute("aria-invalid")).toBe("true"));
    const error = document.getElementById(pathInput().getAttribute("aria-describedby")!.split(" ")[0]!)!;
    expect(error.textContent).toContain("cannot be a write root");
    expect(text()).not.toContain("Save outcome is uncertain");
    expect(pathInput().disabled).toBe(false);
    expect(pathInput().value).toBe("/srv/goat");
  });

  it("asks for a path before saving and reviews an add with delete allowed", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4));
    await render();
    await type(pathInput(), "relative/folder");
    await click(button("Add folder"));
    expect(text()).toContain("Enter an absolute folder path");
    expect(api.patchSettings).not.toHaveBeenCalled();
    await type(pathInput(), "/srv/scratch");
    await click(container.querySelector<HTMLInputElement>('form input[type="checkbox"]')!);
    await click(button("Add folder"));
    expect(dialog()?.textContent).toContain("Chat can create, change, move and delete files inside it");
    expect(api.patchSettings).not.toHaveBeenCalled();
    await click(button("Keep current setting"));
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("reviews letting Chat ask for outside-root writes and blocks them again directly", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4));
    await render();
    expect(text()).toContain("Writes outside the write roots");
    expect(text()).toContain("Blocked. Chat's filesystem tools fail");
    await click(button("Let Chat ask instead"));
    expect(dialog()?.textContent).toContain("open one offered folder for that tool for 15 minutes to 8 hours");
    expect(api.patchSettings).not.toHaveBeenCalled();
    const asking = { ...settingsAt(5), outsideRootWriteMode: "approval_required" };
    api.patchSettings.mockResolvedValue(asking);
    api.fetchSettings.mockResolvedValueOnce(settingsAt(4)).mockResolvedValue(asking);
    await click(button("Let Chat ask"));
    await vi.waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({
        expectedRevision: 4,
        outsideRootWriteMode: "approval_required",
      }),
    );
    await vi.waitFor(() => expect(text()).toContain("Chat now asks before writing outside the write roots."));
    expect(text()).toContain("or elsewhere after you approve the write.");
    const blocked = { ...settingsAt(6), outsideRootWriteMode: "deny" };
    api.patchSettings.mockResolvedValue(blocked);
    api.fetchSettings.mockResolvedValueOnce(asking).mockResolvedValue(blocked);
    await click(button("Block outside-root writes"));
    await vi.waitFor(() =>
      expect(api.patchSettings).toHaveBeenLastCalledWith({ expectedRevision: 5, outsideRootWriteMode: "deny" }),
    );
    await vi.waitFor(() => expect(text()).toContain("Folders opened from approvals stop working."));
  });

  it("adds the OS temp preset and shows the folder the gateway resolved", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4));
    const saved = settingsAt(5, { roots: [{ path: "/tmp/goat-runner", allowDelete: false, preset: "os_temp" }] });
    api.patchSettings.mockResolvedValue(saved);
    await render();
    api.fetchSettings.mockResolvedValueOnce(settingsAt(4)).mockResolvedValue(saved);
    await click(button("Add OS temp folder"));
    await vi.waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({
        expectedRevision: 4,
        operatorWriteRootChange: { action: "add", preset: "os_temp" },
      }),
    );
    await vi.waitFor(() => expect(text()).toContain("Added the OS temp folder: /tmp/goat-runner. Delete is off"));
    expect(button("Add OS temp folder")).toBeUndefined();
    expect(text()).toContain("OS temp folder");
  });

  it("reviews Allow delete, then removes and re-adds the folder at successive versions", async () => {
    const before = settingsAt(4, { roots: [{ path: "/srv/scratch", allowDelete: false, label: "Scratch" }] });
    const removed = settingsAt(5);
    const readded = settingsAt(6, { roots: [{ path: "/srv/scratch", allowDelete: true, label: "Scratch" }] });
    api.fetchSettings.mockResolvedValue(before);
    await render();
    const toggle = [...container.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]')][0]!;
    await click(toggle);
    expect(dialog()?.textContent).toContain("Allow delete in Scratch?");
    expect(dialog()?.textContent).toContain("Deny-wins and approvals still apply");
    expect(api.patchSettings).not.toHaveBeenCalled();
    // Pre-save read, reload after the remove, pre-save read for the add, then the reload after it.
    api.fetchSettings
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(removed)
      .mockResolvedValueOnce(removed)
      .mockResolvedValue(readded);
    api.patchSettings.mockResolvedValueOnce(removed).mockResolvedValueOnce(readded);
    await click(button("Allow delete"));
    await vi.waitFor(() => expect(text()).toContain("Delete is now on in Scratch."));
    expect(api.patchSettings.mock.calls.map(([input]) => input)).toEqual([
      { expectedRevision: 4, operatorWriteRootChange: { action: "remove", path: "/srv/scratch" } },
      {
        expectedRevision: 5,
        operatorWriteRootChange: { action: "add", path: "/srv/scratch", allowDelete: true, label: "Scratch" },
      },
    ]);
  });

  it("removes a root by its saved path", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4, { roots: [{ path: "/srv/scratch", allowDelete: true }] }));
    api.patchSettings.mockResolvedValue(settingsAt(5));
    await render();
    api.fetchSettings.mockResolvedValueOnce(settingsAt(4, { roots: [{ path: "/srv/scratch", allowDelete: true }] }));
    api.fetchSettings.mockResolvedValue(settingsAt(5));
    await click([...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith("Remove"))!);
    await vi.waitFor(() => expect(text()).toContain("Removed /srv/scratch. Files in it are left as they are."));
    expect(api.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 4,
      operatorWriteRootChange: { action: "remove", path: "/srv/scratch" },
    });
  });
});

describe("global filesystem tool access", () => {
  it("routes a dangerous fs.delete change through review and saves a caution change directly", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4));
    await render();
    expect(toolSelect("fs.delete").value).toBe("denied");
    expect(toolSelect("fs.copy").value).toBe("unlisted");
    await choose(toolSelect("fs.delete"), "available");
    expect(text()).toContain(
      "Making fs.delete available lets Chat delete, under your approval rule, in every write root",
    );
    await click(button("Review fs.delete change"));
    expect(dialog()?.textContent).toContain("Deny-wins and approvals still apply");
    expect(dialog()?.textContent).toContain("may run without asking");
    await click(button("Keep current setting"));
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(toolSelect("fs.delete").value).toBe("available");

    const saved = settingsAt(5, { deny: [], allow: ["fs.delete"] });
    api.patchSettings.mockResolvedValue(saved);
    await click(button("Review fs.delete change"));
    api.fetchSettings.mockResolvedValueOnce(settingsAt(4)).mockResolvedValue(saved);
    await click(button("Set fs.delete to Available"));
    await vi.waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({
        expectedRevision: 4,
        globalToolAccessChange: { toolName: "fs.delete", posture: "available" },
      }),
    );
    await vi.waitFor(() => expect(text()).toContain("fs.delete is now Available."));

    const copied = settingsAt(6, { deny: [], allow: ["fs.delete", "fs.copy"] });
    await choose(toolSelect("fs.copy"), "available");
    api.patchSettings.mockResolvedValue(copied);
    api.fetchSettings.mockResolvedValueOnce(saved).mockResolvedValue(copied);
    await click(button("Apply fs.copy"));
    expect(dialog()).toBeNull();
    await vi.waitFor(() =>
      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 5,
        globalToolAccessChange: { toolName: "fs.copy", posture: "available" },
      }),
    );
  });

  it("blocks a stale draft before any mutation", async () => {
    api.fetchSettings.mockResolvedValueOnce(settingsAt(4)).mockResolvedValue(settingsAt(5, { deny: ["fs.copy"] }));
    await render();
    await choose(toolSelect("fs.copy"), "available");
    await click(button("Apply fs.copy"));
    await vi.waitFor(() => expect(text()).toContain("Nothing was saved."));
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("keeps a pending approval visible and links to its exact review", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4));
    api.patchSettings.mockResolvedValue({
      ...settingsAt(4),
      changePlanReceipt: {
        planId: "plan-1",
        status: "awaiting_approval",
        revision: 1,
        risk: "danger",
        summary: "Approval required",
        requiredAction: { kind: "approval", approvalId: "approval-1", actionId: "a", actionNonce: "n", risk: "danger" },
      },
    });
    api.fetchChangePlan.mockResolvedValue({
      schemaVersion: 1,
      planId: "plan-1",
      revision: 1,
      status: "awaiting_approval",
      phase: "authorization",
      kind: "runtime_configuration",
      scope: "runtime",
      adapter: { adapterId: "runtime-configuration", version: 2 },
      intentHash: "intent",
      origin: { workspaceId: "default", surface: "settings" },
      request: {
        kind: "runtime_configuration",
        change: { operation: "tool_global_access", toolName: "fs.write", posture: "available" },
      },
      target: { ownerId: "runtime_settings", resourceId: "tool_global_access:fs.write", expectedRevision: 4 },
      summary: "Approval required",
      approvalRefs: ["approval-1"],
      requiredAction: { kind: "approval", approvalId: "approval-1", actionId: "a", actionNonce: "n", risk: "danger" },
    });
    await render();
    await choose(toolSelect("fs.write"), "available");
    await click(button("Review fs.write change"));
    await click(button("Set fs.write to Available"));
    await vi.waitFor(() => expect(text()).toContain("Approval required"));
    expect(text()).not.toContain("fs.write is now Available");
    await vi.waitFor(() => expect(container.querySelector('a[href^="/inbox?"]')).not.toBeNull());
    const target = new URL(container.querySelector<HTMLAnchorElement>('a[href^="/inbox?"]')!.href);
    expect(target.searchParams.get("approvalId")).toBe("approval-1");
    expect(target.searchParams.get("workspaceId")).toBe("default");
    expect(toolSelect("fs.copy").disabled).toBe(true);
  });

  it("locks every control after an uncertain write until the operator re-reads the settings", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4));
    api.patchSettings.mockRejectedValue(new Error("Lost response"));
    await render();
    await choose(toolSelect("fs.copy"), "available");
    await click(button("Apply fs.copy"));
    await vi.waitFor(() => expect(text()).toContain("Save outcome is uncertain"));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Save outcome is uncertain");
    expect(toolSelect("fs.copy").disabled).toBe(true);
    expect(pathInput().disabled).toBe(true);
    expect(button("Add OS temp folder").disabled).toBe(true);
    await click(button("Refresh"));
    expect(toolSelect("fs.copy").disabled).toBe(true);
    api.fetchSettings.mockResolvedValue(settingsAt(5, { deny: ["fs.delete"], allow: ["fs.copy"] }));
    await click(button("Re-read settings and unlock"));
    await vi.waitFor(() => expect(toolSelect("fs.copy").disabled).toBe(false));
    expect(toolSelect("fs.copy").value).toBe("available");
    expect(text()).toContain("Current settings re-read.");
    expect(button("Re-read settings and unlock")).toBeUndefined();
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps another row's unsaved edit when one row saves", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4));
    await render();
    await choose(toolSelect("fs.copy"), "available");
    await choose(toolSelect("fs.move"), "denied");
    const saved = settingsAt(5, { deny: ["fs.delete"], allow: ["fs.copy"] });
    api.patchSettings.mockResolvedValue(saved);
    api.fetchSettings.mockResolvedValueOnce(settingsAt(4)).mockResolvedValue(saved);
    await click(button("Apply fs.copy"));
    await vi.waitFor(() => expect(text()).toContain("fs.copy is now Available."));
    expect(toolSelect("fs.copy").value).toBe("available");
    expect(button("Apply fs.copy")).toBeUndefined();
    expect(toolSelect("fs.move").value).toBe("denied");
    expect(button("Apply fs.move")).toBeDefined();
  });

  it("says the Files tools are switched off in Capabilities", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(4, { switchedOffToolGroups: ["files"] }));
    await render();
    expect(text()).toContain(
      "The Files tools are switched off in Capabilities › Tools, so these settings have no effect until they're back on.",
    );
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="/capabilities/tools"]')];
    expect(links).toHaveLength(1);
    const target = new URL(links[0]!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname).toBe("/capabilities/tools");
    expect(target.searchParams.get("item")).toBe("group:files");
    expect(links[0]!.getAttribute("href")).toContain("item=group%3Afiles");
    // The note sits above the folders and the tool list it speaks about.
    const note = links[0]!.closest("p")!;
    expect(note.compareDocumentPosition(container.querySelector("#operator-write-roots-title")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The settings stay editable; the note is information, not a lock.
    expect(pathInput().disabled).toBe(false);
  });

  it.each([
    ["no groups are reported", undefined],
    ["only another group is off", ["web_search"]],
  ])("says nothing about Capabilities when %s", async (_name, switchedOffToolGroups) => {
    api.fetchSettings.mockResolvedValue(settingsAt(4, { switchedOffToolGroups }));
    await render();
    expect(text()).not.toContain("switched off in Capabilities");
    expect(container.querySelector('a[href^="/capabilities/tools"]')).toBeNull();
  });

  it("refuses to offer changes when the gateway omits write-access settings", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 4, writeJailRoots: [], readOnlyRoots: [] });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitNavigationProvider>
            <FilesystemWriteRootsControl />
          </CockpitNavigationProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(text()).toContain("did not report write roots or tool access"));
    expect(container.querySelector("select")).toBeNull();
    expect(button("Add folder")).toBeUndefined();
  });
});
