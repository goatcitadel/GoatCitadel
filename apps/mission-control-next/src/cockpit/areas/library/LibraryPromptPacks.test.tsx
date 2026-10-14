// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRoute } from "../../../app/route-model";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { LibraryPromptPacks } from "./LibraryPromptPacks";

const workbench = vi.hoisted(() => ({
  props: undefined as
    | {
        workspaceId?: string;
        variant?: string;
        initialPackId?: string;
        initialRunId?: string;
        initialSessionId?: string;
        initialDetailTab?: string;
        navigate?: (route: AppRoute) => void;
      }
    | undefined,
}));
vi.mock("../../../features/prompt-packs/PromptPacksWorkbenchPage", () => ({
  PromptPacksWorkbenchPage: (props: NonNullable<typeof workbench.props>) => {
    workbench.props = props;
    return <p>Prompt-pack workbench for {props.workspaceId}</p>;
  },
}));

let root: Root;
let container: HTMLDivElement;
async function open(path: string) {
  await act(async () => {
    window.history.replaceState(null, "", path);
    root.render(
      <CockpitNavigationProvider>
        <LibraryPromptPacks workspaceId="workspace-a" />
      </CockpitNavigationProvider>,
    );
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Prompt-pack workbench"));
}

beforeEach(() => {
  workbench.props = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("cockpit prompt-pack workbench", () => {
  it("lazily mounts the shared workbench for the active workspace in its Library variant", async () => {
    await open("/library/prompt-packs?shell=cockpit");
    expect(workbench.props).toMatchObject({ workspaceId: "workspace-a", variant: "library" });
    expect(workbench.props?.initialPackId).toBeUndefined();
  });

  it("focuses the pack named by the view parameter", async () => {
    await open("/library/prompt-packs?shell=cockpit&view=pack%3Apack-1");
    expect(workbench.props?.initialPackId).toBe("pack-1");
  });

  it("ignores a blank pack focus, as the Classic parser does", async () => {
    await open("/library/prompt-packs?shell=cockpit&view=pack%3A%20");
    expect(workbench.props?.initialPackId).toBeUndefined();
  });

  it("opens a pack run's conversation natively in Chat", async () => {
    await open("/library/prompt-packs?shell=cockpit");
    await act(async () => workbench.props!.navigate!({ area: "chat", sessionId: "session-1" } as AppRoute));
    expect(window.location.pathname).toBe("/chat");
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("session-1");
  });
});

it.each([
  ["human", "review"],
  ["auto", "assessment"],
])("passes exact native run/session and %s scoring focus without changing URL/state", async (scoring, tab) => {
  const href =
    "/library/prompt-packs?view=pack%3Apack-1&runId=run%2Fone&sessionId=session%3Atwo&scoring=" +
    scoring +
    "&workspaceId=workspace-a&keep=yes&shell=cockpit#scores";
  await open(href);
  expect(workbench.props).toMatchObject({
    initialPackId: "pack-1",
    initialRunId: "run/one",
    initialSessionId: "session:two",
    initialDetailTab: tab,
    workspaceId: "workspace-a",
  });
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(href);
});
it("retains raw canonical run/session selector bytes for the Gateway owner", async () => {
  await open("/library/prompt-packs?view=pack%3Apack-1&runId=%20run%20&sessionId=%20session%20");
  expect(workbench.props).toMatchObject({ initialRunId: " run ", initialSessionId: " session " });
});
it.each([
  "?runId=r",
  "?view=pack%3Apack-1&sessionId=s",
  "?view=pack%3Apack-1&scoring=human",
  "?view=pack%3Apack-1&runId=r&scoring=unknown",
  "?view=pack%3Apack-1&runId=",
  "?view=pack%3Apack-1&runId=r&runId=other",
  "?view=pack%3Apack-1&runId=r&sessionId=",
  "?view=pack%3Apack-1&view=pack%3Aother",
  "?view=pack%3Apack-1&runId=" + "x".repeat(257),
  "?view=pack%3Apack-1&runId=r&sessionId=" + "x".repeat(257),
])("shows an explicit native outcome for incomplete/conflicting focus %s", async (query) => {
  await act(async () => {
    window.history.replaceState({ retained: true }, "", "/library/prompt-packs" + query + "&keep=yes#evidence");
    root.render(
      <CockpitNavigationProvider>
        <LibraryPromptPacks workspaceId="workspace-a" />
      </CockpitNavigationProvider>,
    );
  });
  expect(container.querySelector('[aria-label="Prompt-pack record outcome"]')).not.toBeNull();
  expect(workbench.props).toBeUndefined();
  const link = container.querySelector("a")!;
  expect(link).not.toBeNull();
  const target = new URL(link.href);
  expect(target.pathname).toBe("/library/prompt-packs");
  expect(target.searchParams.has("runId")).toBe(false);
  expect(target.searchParams.has("sessionId")).toBe(false);
  expect(target.searchParams.has("scoring")).toBe(false);
  expect(target.searchParams.get("keep")).toBe("yes");
  if (new URLSearchParams(query).getAll("view").length > 1) expect(target.searchParams.has("view")).toBe(false);
  expect(target.hash).toBe("#evidence");
  expect(window.history.state).toMatchObject({ retained: true });
});
