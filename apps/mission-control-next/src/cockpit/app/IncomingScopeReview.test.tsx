// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  pathname: "/inbox",
  search: "",
  hash: "",
  navigate: vi.fn(),
}));
const workspaces = vi.hoisted(() => ({ items: [] as Array<{ workspaceId: string; name?: string }> }));
const citadels = vi.hoisted(() => ({ items: [] as Array<{ citadelId: string; name?: string }> }));
vi.mock("./use-cockpit-route", () => ({ useCockpitRoute: () => route }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "citadel-active", activeWorkspaceId: "ws-active" }),
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: workspaces.items })),
}));
vi.mock("@goatcitadel/mission-control-shared/api/citadels", () => ({
  listCitadels: vi.fn(async () => ({ items: citadels.items })),
}));
vi.mock("./ScopeSwitcher", () => ({
  ScopeSwitcher: ({ open, destination }: { open?: boolean; destination?: string }) =>
    open ? <p>switcher for {destination}</p> : null,
}));

import { IncomingScopeReview } from "./IncomingScopeReview";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  route.pathname = "/inbox";
  route.search = "";
  route.hash = "";
  route.navigate.mockReset();
  workspaces.items = [];
  citadels.items = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <IncomingScopeReview />
      </QueryClientProvider>,
    ),
  );
  for (let tick = 0; tick < 5; tick += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

const buttons = () => [...container.querySelectorAll("button")];
const buttonLabels = () => buttons().map((entry) => entry.textContent);
async function click(label: string) {
  const target = buttons().find((entry) => entry.textContent === label);
  if (!target) throw new Error(`No button "${label}" among ${buttonLabels().join(", ")}`);
  await act(async () => target.click());
}

it("names the workspace a link asks for and offers to switch to it", async () => {
  route.search = "?approvalId=a-1&workspaceId=ws-default";
  workspaces.items = [{ workspaceId: "ws-default", name: "Default" }];
  await render();
  expect(container.textContent).toContain("This link is for the Default workspace, not the one you have open.");
  expect(buttonLabels()).toEqual(["Switch to Default", "Stay here"]);
  await click("Switch to Default");
  expect(container.textContent).toContain("switcher for /inbox?approvalId=a-1&workspaceId=ws-default");
});

it("stays here by dropping the requested scope from the address", async () => {
  route.search = "?approvalId=a-1&workspaceId=ws-default";
  route.hash = "#top";
  workspaces.items = [{ workspaceId: "ws-default", name: "Default" }];
  await render();
  await click("Stay here");
  expect(route.navigate).toHaveBeenCalledWith("/inbox?approvalId=a-1#top", { replace: true });
});

it("leaves a bare path when the scope was the only thing in the address", async () => {
  route.search = "?workspaceId=ws-default&citadelId=citadel-b";
  await render();
  await click("Stay here");
  expect(route.navigate).toHaveBeenCalledWith("/inbox", { replace: true });
});

it("says when the workspace isn't in the list and offers no switch", async () => {
  route.search = "?workspaceId=ws-gone";
  workspaces.items = [];
  await render();
  expect(container.textContent).toContain("This link is for a workspace that isn't in your list.");
  expect(buttonLabels()).toEqual(["Review linked scope", "Stay here"]);
});

it("names the Citadel a link asks for when it asks for no workspace", async () => {
  route.search = "?citadelId=citadel-b";
  citadels.items = [{ citadelId: "citadel-b", name: "Studio" }];
  await render();
  expect(container.textContent).toContain("This link is for the Studio Citadel, not the one you have open.");
  expect(buttonLabels()).toEqual(["Switch to Studio", "Stay here"]);
});

it("shows nothing when the link asks for the open scope", async () => {
  route.search = "?workspaceId=ws-active";
  await render();
  expect(container.textContent).toBe("");
});
