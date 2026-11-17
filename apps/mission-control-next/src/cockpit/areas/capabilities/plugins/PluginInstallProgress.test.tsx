// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityPluginDetail } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginInstallProgress } from "./PluginInstallProgress";
import { PLUGIN_ID } from "./plugin-install.test-support";
import type { PluginInstall, PluginInstallState } from "./use-plugin-install";

vi.mock("../../settings/SettingsApprovalDialog", () => ({ SettingsApprovalDialog: () => null }));

let container: HTMLDivElement;
let root: Root;

const DETAIL = {
  pluginId: PLUGIN_ID,
  name: "Meeting tools",
  workspaceId: "ws-plugin",
  pieces: [],
} as unknown as CapabilityPluginDetail;

function flowAt(state: PluginInstallState): PluginInstall {
  return {
    state,
    asking: false,
    chain: false,
    declined: false,
    unreadable: false,
    workspaceId: "ws-plugin",
    inspect: vi.fn(),
    confirm: vi.fn(async () => false),
    checkNow: vi.fn(),
  };
}

async function render(flow: PluginInstall, handedOff?: { played: boolean }) {
  await act(async () =>
    root.render(
      <PluginInstallProgress flow={flow} name="Meeting tools" secretsReady onInstall={vi.fn()} handedOff={handedOff} />,
    ),
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PluginInstallProgress", () => {
  it("animates the current confirmed install once while leaving the status text in place", async () => {
    const done = { phase: "done", pluginId: PLUGIN_ID, detail: DETAIL } as const;
    await render(flowAt({ phase: "following", detail: DETAIL }));
    expect(container.querySelector(".cockpit-install-confirmed")).toBeNull();
    await render(flowAt(done));

    const status = container.querySelector('[role="status"]');
    const icon = status?.querySelector(".cockpit-install-confirmed");
    expect(icon).toBeTruthy();
    expect(status?.textContent).toContain("Meeting tools is installed.");
    await render(flowAt(done));
    expect(status?.querySelector(".cockpit-install-confirmed")).toBe(icon);
  });

  it("does not replay a handed-off confirmation when the inspector remounts its body", async () => {
    const completion = { played: false };
    const flow = flowAt({ phase: "done", pluginId: PLUGIN_ID, detail: DETAIL });
    await render(flow, completion);
    expect(container.querySelector(".cockpit-install-confirmed")).toBeTruthy();

    await act(async () => root.render(null));
    await render(flow, completion);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Meeting tools is installed.");
    expect(container.querySelector(".cockpit-install-confirmed")).toBeNull();
  });
  it("opens a previously completed install without replaying its confirmation", async () => {
    await render(flowAt({ phase: "done", pluginId: PLUGIN_ID, detail: DETAIL }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Meeting tools is installed.");
    expect(container.querySelector(".cockpit-install-confirmed")).toBeNull();
  });
  it("says a plugin handed over to its uninstall in a quiet line, never as a failure", async () => {
    const message = "This plugin is being uninstalled.";
    await render(flowAt({ phase: "failed", message, detail: { ...DETAIL, state: "uninstalling" } }));

    expect(container.textContent).toContain(message);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".text-status-failed")).toBeNull();
  });

  it("still reads out a stopped install as a failure", async () => {
    const message = "Couldn't save Calendar.";
    await render(flowAt({ phase: "failed", message, detail: { ...DETAIL, state: "install_not_finished" } }));

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(container.querySelector(".text-status-failed")?.textContent).toBe(message);
  });
});
