// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CapabilityToolGroupItem } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../../app/CockpitNavigationProvider";
import { heldOffText } from "./GroupSwitchParts";
import { ToolGroupRow } from "./ToolGroupRow";
import { __resetToolGroupSwitchesForTests } from "./use-tool-group-switch";

const prefs = vi.hoisted(() => ({ activeCitadelId: "default", activeWorkspaceId: "ws-1" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
const settings = vi.hoisted(() => ({ patchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings-operations", () => settings);
const plans = vi.hoisted(() => ({ fetchChangePlan: vi.fn(), fetchChangePlans: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", async (original) => ({
  ...(await original<object>()),
  ...plans,
}));

const GIT: CapabilityToolGroupItem = {
  groupId: "git",
  label: "Git",
  description: "Read and change Git repositories.",
  state: "off",
  risk: "caution",
  tools: [{ toolName: "git.status", description: "Show status", risk: "safe", asks: "runs_freely" }],
  blockedToolCount: 0,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function render(group: CapabilityToolGroupItem) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <ToolGroupRow group={group} calls="Not used yet" settingsRevision={3} onOpen={vi.fn()} />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const theSwitch = () => container.querySelector<HTMLButtonElement>('[role="switch"]');

beforeEach(() => {
  plans.fetchChangePlans.mockReset().mockResolvedValue({ items: [] });
  settings.patchSettings.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetToolGroupSwitchesForTests();
});

describe("a tool group a plugin keeps off", () => {
  it("disables a held group's switch and says why", async () => {
    await render({ ...GIT, heldOffBy: [{ pluginId: "meeting-tools", name: "Meeting tools" }] });

    const control = theSwitch()!;
    expect(control.disabled).toBe(true);
    expect(container.textContent).toContain("Off · held by Meeting tools");
    expect(container.textContent).toContain("Kept off by Meeting tools. Uninstalling it turns the group back on.");
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Meeting tools");
    expect(link?.getAttribute("href")).toContain("/capabilities/plugins?item=plugin%3Ameeting-tools");
    expect(settings.patchSettings).not.toHaveBeenCalled();
  });

  it("names every plugin that keeps it off", () => {
    const a = { pluginId: "a", name: "A" };
    const b = { pluginId: "b", name: "B" };
    const c = { pluginId: "c", name: "C" };
    expect(heldOffText([a])).toBe("Off · held by A");
    expect(heldOffText([a, b])).toBe("Off · held by A and B");
    expect(heldOffText([a, b, c])).toBe("Off · held by A and 2 more plugins");
  });

  it("shows GoatCitadel's sentence and the plugin's link when switching on is refused, with no Reload", async () => {
    settings.patchSettings.mockRejectedValue(
      new ApiRequestError("refused", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/settings",
        status: 409,
        body: {
          error: "From Meeting tools. Uninstall it to remove this.",
          code: "PLUGIN_OWNED",
          details: { pluginId: "meeting-tools" },
        },
      }),
    );
    // The list hadn't caught up with the hold yet, so the switch still offers On.
    await render(GIT);
    await act(async () => theSwitch()?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("From Meeting tools. Uninstall it to remove this.");
    expect(container.textContent).not.toContain("Changed elsewhere");
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Reload")).toBe(false);
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Open in Plugins");
    expect(link?.getAttribute("href")).toContain("/capabilities/plugins?item=plugin%3Ameeting-tools");
  });
});
