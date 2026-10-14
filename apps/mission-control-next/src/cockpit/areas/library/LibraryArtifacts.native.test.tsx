// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { LibraryResources } from "./LibraryResources";
import { LibraryResourceDetail } from "./LibraryResourceDetail";
import type { LibraryResource } from "./library-resources";
const owner = vi.hoisted(() => ({
  load: vi.fn(),
  preview: vi.fn(),
  navigate: vi.fn(),
  showTechnicalDetails: false,
  search:
    "?workspaceId=one&citadelId=personal&runId=old&projectId=old&keep=one&keep=two&shell=classic&shellScope=visit",
  hash: "#evidence",
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({
    pathname: "/library/artifacts",
    search: owner.search,
    hash: owner.hash,
    navigate: owner.navigate,
  }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", async (importOriginal) => {
  const original = await importOriginal<typeof import("@goatcitadel/mission-control-shared/state/ui-preferences")>();
  return {
    ...original,
    useUiPreferences: () => ({ ...original.useUiPreferences(), showTechnicalDetails: owner.showTechnicalDetails }),
  };
});
vi.mock("./library-resources", async (original) => ({
  ...(await original<typeof import("./library-resources")>()),
  loadLibraryResources: owner.load,
}));
vi.mock("./library-resource-preview", () => ({
  readLibraryResource: owner.preview,
}));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: import("react").ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer", () => ({
  GeneratedArtifactViewer: () => null,
}));
const artifact: LibraryResource = {
  kind: "artifacts",
  item: {
    artifactId: "artifact /?#",
    workspaceId: "one",
    sessionId: "session /?#",
    turnId: "turn /?#",
    projectId: "project /?#",
    title: "Native artifact",
    kind: "markdown",
    content: "Result",
    contentHash: "a".repeat(64),
    version: 1,
    sourceSurface: "code",
    createdAt: "2026-10-14",
    updatedAt: "2026-10-14",
  },
};
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  owner.showTechnicalDetails = false;
  owner.search =
    "?workspaceId=one&citadelId=personal&runId=old&projectId=old&keep=one&keep=two&shell=classic&shellScope=visit";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  owner.load.mockResolvedValue({
    items: [artifact],
    coverage: "Returned window",
  });
  owner.preview.mockResolvedValue({ text: "Content" });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});
const render = () =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryResources kind="artifacts" workspaceId="one" citadelId="personal" />
      </QueryClientProvider>,
    ),
  );
it("exposes native recorded-source filtering, clears the prior preview, and retains exact route context", async () => {
  owner.search = owner.search.replace("projectId=old", "projectId=project%20%2F%3F%23");
  await render();
  expect(owner.load).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project /?#" }));
  await vi.waitFor(() => expect(container.textContent).toContain("Native artifact"));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Inspect Native artifact"]')!.click(),
  );
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  const select = container.querySelector<HTMLSelectElement>("select")!;
  select.focus();
  await act(async () => {
    select.value = "code";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const target = new URL(owner.navigate.mock.calls[0]![0], "http://cockpit.invalid");
  expect(target.searchParams.get("sourceSurface")).toBe("code");
  expect(target.searchParams.get("shell")).toBe("cockpit");
  expect(target.searchParams.has("shellScope")).toBe(false);
  expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
  expect(target.searchParams.get("workspaceId")).toBe("one");
  expect(target.hash).toBe("#evidence");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  owner.search = target.search;
  await render();
  await vi.waitFor(() => expect(owner.load).toHaveBeenCalledWith(expect.objectContaining({ sourceSurface: "code" })));
  expect(document.activeElement).toBe(select);
  expect(container.querySelector('a[href*="shell=classic"]')).toBeNull();
});
it("does not read an unsupported artifact directory source and offers an explicit recovery choice", async () => {
  owner.search = "?sourceSurface=unknown";
  await render();
  expect(owner.load).not.toHaveBeenCalled();
  const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Refresh artifacts",
  )!;
  expect(refresh.disabled).toBe(true);
  await act(async () => refresh.click());
  expect(owner.load).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Artifact source filter unavailable");
  expect(container.textContent).not.toContain("Loading artifacts");
  expect(container.querySelector("select")?.value).toBe("unknown");
});
it("retains exact artifact/source/run identities and technical provenance in native destinations", async () => {
  const value = {
    ...artifact,
    item: { ...artifact.item, runId: "run /?#" },
  } as LibraryResource;
  await act(async () => root.render(<LibraryResourceDetail resource={value} workspaceId="one" citadelId="personal" />));
  for (const [label, path] of [
    ["Open artifact conversation", "/chat"],
    ["Reopen exact artifact", "/library/artifacts"],
    ["Open artifact run", "/work/runs/run%20%2F%3F%23"],
  ]) {
    const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find((node) => node.textContent === label)!;
    const target = new URL(link.href);
    expect(target.pathname).toBe(path);
    for (const [key, value] of [
      ["artifactId", "artifact /?#"],
      ["sessionId", "session /?#"],
      ["turnId", "turn /?#"],
      ["projectId", "project /?#"],
      ["runId", "run /?#"],
      ["workspaceId", "one"],
      ["citadelId", "personal"],
      ["shell", "cockpit"],
    ] as const)
      expect(target.searchParams.get(key)).toBe(value);
    expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
    expect(target.searchParams.has("shellScope")).toBe(false);
    expect(target.hash).toBe("#evidence");
  }
  expect(container.textContent).not.toContain("Artifact provenance");
  expect(container.querySelector("details pre")).toBeNull();
  owner.showTechnicalDetails = true;
  await act(async () => root.render(<LibraryResourceDetail resource={value} workspaceId="one" citadelId="personal" />));
  expect(container.textContent).toContain("Artifact provenance");
  expect(container.querySelector("details pre")?.textContent).toContain("a".repeat(64));
});
it("does not invent a run or source continuation for a different workspace", async () => {
  await act(async () =>
    root.render(
      <LibraryResourceDetail
        resource={
          {
            ...artifact,
            item: { ...artifact.item, workspaceId: "other" },
          } as LibraryResource
        }
        workspaceId="one"
        citadelId="personal"
      />,
    ),
  );
  expect([...container.querySelectorAll("a")].some((x) => x.textContent?.startsWith("Open artifact"))).toBe(false);
});

it("omits a displaced incoming run when the current artifact has no recorded execution linkage", async () => {
  await act(async () =>
    root.render(<LibraryResourceDetail resource={artifact} workspaceId="one" citadelId="personal" />),
  );
  for (const label of ["Open artifact conversation", "Reopen exact artifact"]) {
    const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find((node) => node.textContent === label)!;
    const target = new URL(link.href);
    expect(target.searchParams.has("runId")).toBe(false);
    expect(target.searchParams.get("artifactId")).toBe("artifact /?#");
    expect(target.searchParams.get("sessionId")).toBe("session /?#");
    expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
    expect(target.hash).toBe("#evidence");
  }
  expect([...container.querySelectorAll("a")].some((link) => link.textContent === "Open artifact run")).toBe(false);
});

it("offers the existing use-in-Chat continuation without choosing its source session or an unrelated run", async () => {
  const linked = { ...artifact, item: { ...artifact.item, runId: "run /?#" } } as LibraryResource;
  await act(async () =>
    root.render(<LibraryResourceDetail resource={linked} workspaceId="one" citadelId="personal" />),
  );
  const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
    (node) => node.textContent === "Use artifact in Chat",
  )!;
  const target = new URL(link.href);
  expect(target.pathname).toBe("/chat");
  expect(target.searchParams.get("artifactId")).toBe("artifact /?#");
  expect(target.searchParams.get("projectId")).toBe("project /?#");
  expect(target.searchParams.get("workspaceId")).toBe("one");
  expect(target.searchParams.get("citadelId")).toBe("personal");
  for (const key of ["sessionId", "turnId", "runId", "shellScope"]) expect(target.searchParams.has(key)).toBe(false);
  expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
  expect(target.hash).toBe("#evidence");
});
