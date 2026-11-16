// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({ belowDesktop: false }));
const names = vi.hoisted(() => ({
  citadel: { phase: "ready", name: "Personal" } as { phase: "loading" | "failed" | "ready"; name?: string },
  workspace: { phase: "ready", name: "Sandbox" } as { phase: "loading" | "failed" | "ready"; name?: string },
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => media.belowDesktop }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "personal", activeWorkspaceId: "sandbox" }),
}));
vi.mock("../data/use-citadel-name", () => ({ useCitadelNameRead: () => names.citadel }));
vi.mock("../data/use-workspace-name", () => ({ useWorkspaceNameRead: () => names.workspace }));

import { AreaHeader } from "../ui/AreaHeader";
import { cockpitScopeLine, ScopeLineProvider } from "./scope-line";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  names.citadel = { phase: "ready", name: "Personal" };
  names.workspace = { phase: "ready", name: "Sandbox" };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function renderWithProvider() {
  await act(async () =>
    root.render(
      <ScopeLineProvider>
        <AreaHeader title="Inbox" />
      </ScopeLineProvider>,
    ),
  );
}

it("shows the scope on a phone or tablet page (U-GL-027)", async () => {
  media.belowDesktop = true;
  await renderWithProvider();
  expect(container.querySelector("[data-cockpit-page-scope]")?.textContent).toBe("In Personal / Sandbox");
});

it("shows nothing on a desktop, where the sidebar names the scope", async () => {
  media.belowDesktop = false;
  await renderWithProvider();
  expect(container.querySelector("[data-cockpit-page-scope]")).toBeNull();
});

it("shows nothing outside a provider", async () => {
  await act(async () => root.render(<AreaHeader title="Inbox" />));
  expect(container.querySelector("[data-cockpit-page-scope]")).toBeNull();
});

async function scopeText() {
  media.belowDesktop = true;
  await renderWithProvider();
  return container.querySelector("[data-cockpit-page-scope]")?.textContent;
}

it("says the workspace is loading until both names are read", async () => {
  names.citadel = { phase: "loading" };
  expect(await scopeText()).toBe("Loading workspace…");
});

it("keeps saying loading while the workspace list loads, never a fallback name", async () => {
  names.workspace = { phase: "loading" };
  expect(await scopeText()).toBe("Loading workspace…");
});

it("says the workspace is unavailable when the Citadel read failed", async () => {
  names.citadel = { phase: "failed" };
  expect(await scopeText()).toBe("Workspace unavailable");
});

it("says the workspace is unavailable when the workspace read failed", async () => {
  names.workspace = { phase: "failed" };
  expect(await scopeText()).toBe("Workspace unavailable");
});

it("shows a Citadel or workspace really named like a marker as its name", async () => {
  names.citadel = { phase: "ready", name: "Citadel unavailable" };
  names.workspace = { phase: "ready", name: "Loading workspace…" };
  expect(await scopeText()).toBe("In Citadel unavailable / Loading workspace…");
  names.citadel = { phase: "ready", name: "Reading Citadel..." };
  act(() => root.unmount());
  root = createRoot(container);
  expect(await scopeText()).toBe("In Reading Citadel... / Loading workspace…");
});

it("carries no live region", async () => {
  await scopeText();
  expect(
    container.querySelector("[data-cockpit-page-scope]")?.closest("[aria-live],[role=status],[role=alert]"),
  ).toBeNull();
});

it("keeps the More sheet wording", () => {
  expect(cockpitScopeLine("Reading Citadel...", undefined)).toBe("Loading workspace…");
  expect(cockpitScopeLine("Personal", undefined)).toBe("Personal / Workspace");
});
