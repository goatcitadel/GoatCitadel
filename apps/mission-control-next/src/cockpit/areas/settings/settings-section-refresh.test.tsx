// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { BrowserErrandsControl } from "./BrowserErrandsControl";
import { BudgetModeControl } from "./BudgetModeControl";
import { ChatThinkingStreamControl } from "./ChatThinkingStreamControl";
import { ClaudeCliToolBridgeControl } from "./ClaudeCliToolBridgeControl";
import { ClaudeCliWarmContinuationControl } from "./ClaudeCliWarmContinuationControl";
import { FeatureSwitchesSettings } from "./FeatureSwitchesSettings";
import { FilesystemWriteRootsControl } from "./FilesystemWriteRootsControl";
import { SettingsApprovalSkipControl } from "./SettingsApprovalSkipControl";
import { WebSearchSettings } from "./WebSearchSettings";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchSettings: api.fetchSettings,
}));

const CONTROLS: Array<[string, () => ReactNode]> = [
  ["Browser errands", () => <BrowserErrandsControl />],
  ["Budget preference", () => <BudgetModeControl />],
  ["Model reasoning in Chat", () => <ChatThinkingStreamControl />],
  ["Claude Code CLI tools", () => <ClaudeCliToolBridgeControl />],
  ["Claude Code CLI faster tool steps", () => <ClaudeCliWarmContinuationControl />],
  ["Features", () => <FeatureSwitchesSettings />],
  ["Filesystem access", () => <FilesystemWriteRootsControl />],
  ["Apply Settings changes without asking", () => <SettingsApprovalSkipControl />],
  ["Web & Search", () => <WebSearchSettings />],
];
const GOOD_READ = {
  revision: 2,
  budgetMode: "balanced",
  features: {},
  writeJailRoots: [],
  readOnlyRoots: [],
  operatorWriteRoots: [],
  globalToolAccess: { deny: [], allow: [] },
  networkAllowlist: [],
};
const roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  api.fetchSettings.mockResolvedValue(structuredClone(GOOD_READ));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("a Settings page has one Refresh, not one per section (U-ST-014)", () => {
  it.each(CONTROLS)("%s has no Refresh button of its own", async (title, render) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitNavigationProvider>{render()}</CockpitNavigationProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(api.fetchSettings).toHaveBeenCalled());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.querySelector("h3")?.textContent, title).toBeTruthy();
    const refresh = [...container.querySelectorAll("button")].filter((button) => button.textContent === "Refresh");
    expect(refresh).toHaveLength(0);
    client.clear();
  });
});
