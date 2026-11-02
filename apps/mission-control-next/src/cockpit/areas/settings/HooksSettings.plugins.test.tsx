// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HookRecord } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetIntegrationConnectionMutationsForTests } from "../../../features/native-routes/settings/integration-connection-mutation";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { HooksSettings } from "./HooksSettings";

// Hooks carry no plugin mark yet, so Delete stays on a plugin's hook; GoatCitadel refuses it in its own words, and the
// plugin it names is linked (D7, D10).

const api = vi.hoisted(() => ({
  createWorkspaceHook: vi.fn(),
  deleteWorkspaceHook: vi.fn(),
  fetchWorkspaceHookRuns: vi.fn(),
  fetchWorkspaceHooks: vi.fn(),
  redriveWorkspaceHookRun: vi.fn(),
  testWorkspaceHook: vi.fn(),
}));
vi.mock("../../../features/native-routes/settings/sections/hooks-api", () => api);
vi.mock("../../data/use-workspace-name", () => ({ useActiveWorkspaceLabel: () => "Research" }));

let root: Root;
let container: HTMLDivElement;
const button = (name: string) => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.replace(/s+/g, " ").trim() === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
};
/** A hook in the list, whose button reads its label, trigger and state. */
const hookButton = (label: string) => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
};
const hook: HookRecord = {
  hookId: "hook",
  workspaceId: "fixture",
  label: "Observer",
  trigger: "tool.call.after",
  phase: "after",
  mode: "observe",
  enabled: true,
  priority: 100,
  timeoutMs: 5000,
  failPolicy: "open",
  dataScope: "metadata",
  action: { type: "webhook", webhook: { url: "https://hooks.example.com/x", secretRef: "ref" } },
  createdAt: "2026-09-30T12:00:00Z",
  updatedAt: "2026-09-30T12:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetIntegrationConnectionMutationsForTests();
  api.fetchWorkspaceHooks.mockResolvedValue({ items: [hook] });
  api.fetchWorkspaceHookRuns.mockResolvedValue({ items: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("answers a plugin's hook deletion with the plugin's own sentence and a link to it", async () => {
  api.deleteWorkspaceHook.mockRejectedValue(
    new ApiRequestError("refused", {
      kind: "http",
      method: "DELETE",
      path: "/api/v1/workspaces/fixture/hooks/hook",
      status: 409,
      body: {
        error: "From Meeting tools. Uninstall it to remove this.",
        code: "PLUGIN_OWNED",
        details: { pluginId: "meeting-tools" },
      },
    }),
  );
  await act(async () => {
    root.render(
      <CockpitNavigationProvider>
        <HooksSettings workspaceId="fixture" />
      </CockpitNavigationProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => hookButton("Observer").click());
  await act(async () => button("Review hook deletion").click());
  await act(async () => button("Apply reviewed hook action").click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(api.deleteWorkspaceHook).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("From Meeting tools. Uninstall it to remove this.");
  const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Open in Plugins");
  expect(link?.getAttribute("href")).toContain("/capabilities/plugins?item=plugin%3Ameeting-tools");
});
