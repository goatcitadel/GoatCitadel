// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IntegrationSettingsOwner } from "../../../features/native-routes/settings/sections/use-integration-settings";
import { IntegrationCatalogEvidence } from "./IntegrationCatalogEvidence";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import {
  __resetFormDirtyRegistryForTests,
  useFormDirty,
  getDirtySectionKeys,
} from "../../../features/native-routes/library/use-form-dirty";
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace", activeCitadelId: "citadel" }),
}));
vi.mock("../../data/use-workspace-name", () => ({ useActiveWorkspaceLabel: () => "Reviewed workspace" }));
let root: Root, host: HTMLDivElement;
const discard = vi.fn(),
  callbacks = {
    closePanel: vi.fn(),
    confirmReplayAudit: vi.fn(),
    cancelReplayAudit: vi.fn(),
    confirmExternalReview: vi.fn(),
    cancelExternalReview: vi.fn(),
  };
function Harness({
  workspace = "workspace",
  dirty = false,
  runId = "audit:review",
}: {
  workspace?: string;
  dirty?: boolean;
  runId?: string;
}) {
  useFormDirty("replay-evidence-draft", dirty, {
    label: "Retained evidence draft",
    keepDraft: true,
    onDiscard: discard,
  });
  const owner = {
    panel: "history",
    activeWorkspaceId: workspace,
    selectedConnectionId: "connection",
    lastReplayAuditRunId: runId,
    loading: false,
    data: { issues: [], externalConnectorServices: [], sideEffectRuns: [] },
    externalMutation: { phase: "idle", locked: false },
    replayMutation: { phase: "idle", locked: false },
    externalReview: null,
    replayReview: null,
    ...callbacks,
  } as unknown as IntegrationSettingsOwner;
  return <IntegrationCatalogEvidence owner={owner} />;
}
async function render(workspace = "workspace", dirty = false, runId = "audit:review") {
  await act(async () =>
    root.render(
      <CockpitNavigationProvider>
        <Harness workspace={workspace} dirty={dirty} runId={runId} />
      </CockpitNavigationProvider>,
    ),
  );
}
const link = () =>
  [...host.querySelectorAll("a")].find((item) => item.textContent?.includes("Open run for the run-again check"))!;
async function click(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetFormDirtyRegistryForTests();
  window.history.replaceState(
    { retained: true },
    "",
    "/capabilities/connectors/advanced?keep=yes&citadelId=citadel&workspaceId=stale&runId=stale&sessionId=carried&view=run-detail&shell=cockpit&shellScope=visit#delivery",
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  __resetFormDirtyRegistryForTests();
});
it("opens the exact confirmed replay audit in native Work with query/fragment context and no repeated creation", async () => {
  await render();
  const target = new URL(link().href);
  expect(target.pathname).toBe("/work/runs/audit%3Areview");
  expect(target.searchParams.get("runId")).toBe("audit:review");
  expect(target.searchParams.get("workspaceId")).toBe("workspace");
  expect(target.searchParams.get("citadelId")).toBe("citadel");
  expect(target.searchParams.get("sessionId")).toBe("carried");
  expect(target.searchParams.get("keep")).toBe("yes");
  expect(target.searchParams.get("shell")).toBe("cockpit");
  expect(target.searchParams.has("view")).toBe(false);
  expect(target.searchParams.has("shellScope")).toBe(false);
  expect(target.hash).toBe("#delivery");
  const push = vi.spyOn(window.history, "pushState");
  await act(async () => {
    link().click();
    link().click();
  });
  expect(push).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe("/work/runs/audit%3Areview");
  expect(window.location.hash).toBe("#delivery");
  expect(callbacks.confirmReplayAudit).not.toHaveBeenCalled();
  expect(callbacks.confirmExternalReview).not.toHaveBeenCalled();
  push.mockRestore();
});
it("keeps the real dirty review for Cancel and rejects its retained decision after workspace ABA", async () => {
  await render("workspace", true);
  await act(async () => link().click());
  expect(window.location.pathname).toBe("/capabilities/connectors/advanced");
  await click("Cancel");
  expect(getDirtySectionKeys()).toContain("replay-evidence-draft");
  expect(discard).not.toHaveBeenCalled();
  await act(async () => link().click());
  const stale = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "Keep draft and close",
  )!;
  expect(stale).toBeTruthy();
  await render("other", true);
  await render("workspace", true);
  await act(async () => stale.click());
  expect(window.location.pathname).toBe("/capabilities/connectors/advanced");
  expect(getDirtySectionKeys()).toContain("replay-evidence-draft");
  expect(discard).not.toHaveBeenCalled();
  expect(callbacks.confirmReplayAudit).not.toHaveBeenCalled();
});
it("does not invent a run destination when the canonical creation owner has no confirmed audit ID", async () => {
  await render("workspace", false, "");
  expect(link()).toBeUndefined();
  expect(callbacks.confirmReplayAudit).not.toHaveBeenCalled();
});
