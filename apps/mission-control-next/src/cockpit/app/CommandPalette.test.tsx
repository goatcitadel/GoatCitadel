// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { CommandPalette } from "./CommandPalette";
import type { PaletteSearchGroup } from "./command-palette-search";

const controls = vi.hoisted(() => ({
  navigate: vi.fn(),
  transition: vi.fn(),
  setTheme: vi.fn(),
  setDensity: vi.fn(),
  switchShell: vi.fn(),
  inspect: vi.fn(),
  create: vi.fn(),
  search: { groups: [] as PaletteSearchGroup[], loading: false, error: undefined as string | undefined },
  attempt: undefined as undefined | { state: string; message: string; mode: string; sessionId?: string },
  read: { isFetching: false, isError: false, dataUpdatedAt: 0 },
}));
vi.mock("./use-cockpit-route", () => ({
  useCockpitRoute: () => ({ navigate: controls.navigate, requestTransition: controls.transition }),
}));
vi.mock("./use-cockpit-shell-switch", () => ({
  useCockpitShellSwitch: () => ({ request: controls.switchShell, feedback: null }),
}));
vi.mock("./inspector", () => ({ useInspector: () => ({ open: controls.inspect }) }));
vi.mock("./use-command-palette-search", () => ({ useCommandPaletteSearch: () => controls.search }));
vi.mock("./use-command-new-chat", () => ({
  useCommandNewChat: () => ({ create: controls.create, blocked: false, attempt: controls.attempt }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      activeProviderId: "local",
      activeModel: "recorded-model",
      items: [{ workspaceId: "workspace-a", name: "Research" }],
    },
    isPending: false,
    ...controls.read,
  }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({
    theme: "dark",
    density: "comfortable",
    activeWorkspaceId: "workspace-a",
    activeCitadelId: "citadel-a",
    setTheme: controls.setTheme,
    setDensity: controls.setDensity,
  }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  controls.transition.mockImplementation(
    (action: (review: { isCurrent: () => boolean; signal: AbortSignal; navigate: typeof controls.navigate }) => void) =>
      action({ isCurrent: () => true, signal: new AbortController().signal, navigate: controls.navigate }),
  );
  controls.search = { groups: [], loading: false, error: undefined };
  controls.attempt = undefined;
  controls.read = { isFetching: false, isError: false, dataUpdatedAt: 0 };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CommandPalette", () => {
  it("keeps the last known Gateway default while it is read again and beside a failed read", () => {
    controls.read = { isFetching: true, isError: false, dataUpdatedAt: Date.now() };
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    expect(document.body.textContent).toContain("Gateway default: local / recorded-model.");
    expect(document.body.textContent).not.toContain("Reading Gateway default…");
    controls.read = { isFetching: false, isError: true, dataUpdatedAt: Date.now() };
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    expect(document.body.textContent).toContain(
      "Gateway default: local / recorded-model. Showing the last version from",
    );
  });

  it("names the workspace instead of printing its id", () => {
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    const text = document.querySelector('[role="dialog"]')!.textContent ?? "";
    expect(text).toContain("Workspace: Research.");
    expect(text).not.toContain("workspace-a");
  });

  it("does not replay a confirmed creation that was already opened before this palette open", () => {
    const opened = {
      state: "confirmed",
      message: "Conversation created and independently verified.",
      mode: "chat",
      sessionId: "s1",
    };
    controls.attempt = opened;
    act(() => root.render(<CommandPalette open={false} onOpenChange={() => undefined} />));
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain("Conversation created");
    controls.attempt = { ...opened, sessionId: "s2" };
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Conversation created");
  });

  it("keeps an unconfirmed creation visible so it is never retried blindly", () => {
    controls.attempt = { state: "unknown", message: "Creation outcome is unconfirmed.", mode: "chat" };
    act(() => root.render(<CommandPalette open={false} onOpenChange={() => undefined} />));
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Creation outcome is unconfirmed.");
  });

  it.each(["Enter", " "])("keeps disclosure activation %j separate from the selected New chat command", (key) => {
    controls.search.groups = [
      {
        id: "threads",
        label: "Conversations",
        coverage: "Up to ten current workspace matches.",
        items: [],
      },
    ];
    act(() => {
      root.render(<CommandPalette open onOpenChange={() => undefined} />);
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const selected = dialog.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')!;
    expect(selected.textContent).toMatch(/^New chat/);
    const summary = dialog.querySelector<HTMLElement>('section[aria-label="Conversations search coverage"] summary')!;
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    const activation = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => {
      summary.focus();
      summary.dispatchEvent(activation);
    });
    expect(document.activeElement).toBe(summary);
    expect(activation.defaultPrevented).toBe(false);
    expect(controls.create).not.toHaveBeenCalled();
    expect(controls.navigate).not.toHaveBeenCalled();
    // Happy DOM does not synthesize keyboard default activation. Its native summary
    // click proves the untouched disclosure still opens; the browser lane proves keys.
    act(() => {
      summary.click();
    });
    expect(details.open).toBe(true);
    expect(controls.create).not.toHaveBeenCalled();
    const input = dialog.querySelector<HTMLInputElement>("[cmdk-input]")!;
    act(() => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(controls.create).toHaveBeenCalledTimes(1);
  });

  it("keeps source evidence and live messages outside the selectable cmdk listbox", async () => {
    controls.search = {
      loading: true,
      error: "Some owners are unavailable.",
      groups: [
        {
          id: "threads",
          label: "Conversations",
          coverage: "Up to ten current workspace matches.",
          items: [
            {
              id: "session-a",
              label: "Exact conversation",
              description: "Workspace conversation",
              target: { href: "/chat?shell=cockpit&sessionId=session-a" },
            },
          ],
        },
        { id: "inbox", label: "Inbox", coverage: "Recent scoped items.", items: [] },
        { id: "library", label: "Library", coverage: "Unavailable.", items: [], error: "Library unavailable." },
      ],
    };
    act(() => {
      root.render(<CommandPalette open onOpenChange={() => undefined} />);
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const report = await axe.run(dialog, { runOnly: ["aria-required-children", "aria-required-parent"] });
    expect(report.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ html }) => html) }))).toEqual([]);
    const listbox = dialog.querySelector('[role="listbox"]')!;
    expect(listbox.querySelector("details, summary, [role='status'], [role='alert']")).toBeNull();
    expect(dialog.textContent).toContain("Library unavailable.");
    expect(dialog.textContent).toContain("No matches in this source’s returned window.");
    expect(dialog.textContent).toContain("Up to ten current workspace matches.");
    const item = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
      node.textContent?.startsWith("Exact conversation"),
    );
    expect(item).toBeDefined();
    act(() => {
      item!.click();
    });
    expect(controls.navigate).toHaveBeenCalledWith("/chat?shell=cockpit&sessionId=session-a");
  });

  it("uses the real cmdk input label while keeping the dialog name distinct", () => {
    act(() => {
      root.render(<CommandPalette open onOpenChange={() => undefined} />);
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const input = dialog?.querySelector<HTMLInputElement>('input[role="combobox"][cmdk-input]');
    expect(dialog).not.toBeNull();
    expect(input).not.toBeNull();
    // cmdk supplies aria-labelledby; that generated label takes priority over aria-label.
    const inputLabel = document.getElementById(input!.getAttribute("aria-labelledby")!);
    expect(inputLabel?.textContent).toBe("Search or run a command");
    expect(inputLabel?.getAttribute("for")).toBe(input!.id);
    expect(input!.hasAttribute("aria-label")).toBe(false);
    const dialogLabel = document.getElementById(dialog!.getAttribute("aria-labelledby")!);
    expect(dialogLabel?.textContent).toBe("Command palette");
    expect(dialogLabel).not.toBe(inputLabel);
  });

  it("offers all areas and the classic view", () => {
    act(() => {
      root.render(<CommandPalette open onOpenChange={() => undefined} />);
    });
    const body = document.body.textContent ?? "";
    for (const label of [
      "Go to Chat",
      "Go to Inbox",
      "Go to Work",
      "Go to Library",
      "Go to System",
      "Switch to classic Mission Control",
    ]) {
      expect(body).toContain(label);
    }
    expect(body).toContain("Switch to compact density");
    expect(body).toContain("Gateway default: local / recorded-model");
    expect(body).toContain("Conversation overrides stay in Chat");
    expect(body).toContain("New chat");
  });

  it("dispatches explicit owner actions and preserves the guarded classic handoff", () => {
    const close = vi.fn();
    act(() => {
      root.render(<CommandPalette open onOpenChange={close} />);
    });
    const click = (text: string) => {
      const item = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((node) =>
        node.textContent?.startsWith(text),
      );
      expect(item).toBeDefined();
      act(() => {
        item!.click();
      });
    };
    click("New chat");
    expect(controls.create).toHaveBeenCalledTimes(1);
    expect(controls.navigate).not.toHaveBeenCalled();
    click("Choose default model");
    expect(controls.navigate).toHaveBeenCalledWith("/settings/models?shell=cockpit#providers");
    click("Switch to compact density");
    expect(controls.setDensity).toHaveBeenCalledWith("compact");
    click("Switch to classic");
    expect(controls.switchShell).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(false);
  });
});
