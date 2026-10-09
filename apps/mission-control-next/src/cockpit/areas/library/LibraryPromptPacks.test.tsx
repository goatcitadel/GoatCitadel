// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRoute } from "../../../app/route-model";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { LibraryPromptPacks } from "./LibraryPromptPacks";

const workbench = vi.hoisted(() => ({
  props: undefined as
    | { workspaceId?: string; variant?: string; initialPackId?: string; navigate?: (route: AppRoute) => void }
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
