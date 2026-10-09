// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ProjectImport } from "./ProjectImport";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
const api = vi.hoisted(() => ({ import: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ importChatProject: api.import }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "one", activeCitadelId: "citadel" }),
}));
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <ProjectImport workspaceId="one" citadelId="citadel" refresh={async () => {}} />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
}
async function click(name: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => !item.closest('[aria-hidden="true"]') && item.textContent === name,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function input(label: string, value: string) {
  const field = [...host.querySelectorAll("label")].find((item) => item.textContent?.includes(label))!;
  const target = document.getElementById(field.htmlFor) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("reviews source/destination, Cancel performs no write and confirmed owner receipt is explicit", async () => {
  await render();
  await input("Folder path", "C:/owned-fixture");
  await click("Review project import");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("C:/owned-fixture");
  await click("Cancel");
  expect(api.import).not.toHaveBeenCalled();
  api.import.mockResolvedValue({
    project: { projectId: "new", workspaceId: "one", name: "Imported" },
    sourceType: "local_folder",
    materializedPath: "managed/new",
    repoReady: true,
    imported: true,
  });
  await click("Review project import");
  await click("Confirm project import");
  expect(api.import).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "one",
    citadelId: "citadel",
    name: undefined,
    sourceType: "local_folder",
    sourcePath: "C:/owned-fixture",
  });
  expect(host.textContent).toContain("Source imported");
});
it("keeps failed import draft and locks an unconfirmed identical request", async () => {
  api.import.mockRejectedValue(new Error("missing folder"));
  await render();
  await input("Folder path", "missing");
  await click("Review project import");
  await click("Confirm project import");
  expect(host.textContent).toContain("Import outcome is not confirmed");
  expect((host.querySelector("input") as HTMLInputElement).value).toBe("missing");
  expect(
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Review project import")?.disabled,
  ).toBe(true);
});
it("closes captured import review on an access change without sending", async () => {
  await render();
  await input("Folder path", "C:/owned");
  await click("Review project import");
  await act(async () => notifyGatewayAccessChanged());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.import).not.toHaveBeenCalled();
});
