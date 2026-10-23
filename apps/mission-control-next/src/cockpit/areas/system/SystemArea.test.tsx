// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SystemArea } from "./SystemArea";

const route = vi.hoisted(() => ({ rest: [] as string[] }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ rest: route.rest, navigate: vi.fn() }) }));
vi.mock("./HealthOverview", () => ({ HealthOverview: () => <p>Health page</p> }));
vi.mock("./SystemRuntime", () => ({
  SystemRuntime: ({ section }: { section?: string }) => <p>Runtime page {section ?? ""}</p>,
}));
vi.mock("./SpendDetails", () => ({ SpendDetails: () => <p>Spend details page</p> }));
vi.mock("./SpendOverview", () => ({ SpendOverview: () => <p>Spend page</p> }));
vi.mock("./SystemActivity", () => ({ SystemActivity: () => <p>Activity page</p> }));
vi.mock("./SystemSessions", () => ({ SystemSessions: () => <p>Sessions page</p> }));
vi.mock("./SystemDashboards", () => ({ SystemDashboards: () => <p>Dashboards page</p> }));
vi.mock("./SystemDiagnostics", () => ({ SystemDiagnostics: () => <p>Diagnostics page</p> }));
vi.mock("./SystemQuality", () => ({ SystemQuality: () => <p>Quality page</p> }));
vi.mock("./SystemBrowserSessions", () => ({ SystemBrowserSessions: () => <p>Browser sessions page</p> }));
vi.mock("./SystemImprovement", () => ({ SystemImprovement: () => <p>Improvement page</p> }));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("keeps old runtime diagnostics bookmarks on the native Diagnostics page", () => {
  route.rest = ["runtime", "diagnostics"];
  act(() => root.render(<SystemArea />));
  expect(host.textContent).toBe("Diagnostics page");
});

it("opens the native Runtime page at System › Runtime", () => {
  route.rest = ["runtime"];
  act(() => root.render(<SystemArea />));
  expect(host.textContent?.trim()).toBe("Runtime page runtime");
});

it("opens the native Spend details page", () => {
  route.rest = ["spend", "details"];
  act(() => root.render(<SystemArea />));
  expect(host.textContent).toBe("Spend details page");
});
