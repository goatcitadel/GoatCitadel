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
vi.mock("../data/use-model-label", () => ({
  useModelLabel: (providerId?: string, modelId?: string) =>
    providerId === "local" && modelId === "recorded-model" ? "Recorded Model · Local runtime" : "Unknown model",
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({
    theme: "dark",
    themePreference: "dark",
    density: "comfortable",
    activeWorkspaceId: "workspace-a",
    activeCitadelId: "citadel-a",
    setTheme: controls.setTheme,
    setDensity: controls.setDensity,
  }),
}));

async function ready() {
  await act(async () => {
    await import("./CommandPaletteView");
  });
  await vi.waitFor(() => expect(document.querySelector("[cmdk-input]")).not.toBeNull());
}

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
  it("shows each source still searching on its own, keeping other groups", async () => {
    controls.search.groups = [
      { id: "threads", label: "Conversations", items: [], coverage: "", searching: true },
      {
        id: "notes",
        label: "Notes",
        items: [{ id: "n1", label: "Needle note", description: "Note", target: { href: "/library/notes" } }],
        coverage: "Bounded window.",
      },
    ];
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    await ready();
    const threads = document.querySelector<HTMLElement>('section[aria-label="Conversations search coverage"]')!;
    expect(threads.textContent).toContain("Searching…");
    expect(threads.textContent).not.toContain("No matches");
    expect(document.body.textContent).toContain("Needle note");
  });
  it("keeps the last known default model while it is read again and beside a failed read", async () => {
    controls.read = { isFetching: true, isError: false, dataUpdatedAt: Date.now() };
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    await ready();
    expect(document.body.textContent).toContain("Default model: Recorded Model · Local runtime.");
    expect(document.body.textContent).not.toContain("Reading the default model…");
    expect(document.body.textContent).not.toContain("recorded-model");
    controls.read = { isFetching: false, isError: true, dataUpdatedAt: Date.now() };
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    await ready();
    expect(document.body.textContent).toContain(
      "Default model: Recorded Model · Local runtime. Showing the last version from",
    );
  });

  it("names the workspace instead of printing its id", async () => {
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    await ready();
    const text = document.querySelector('[role="dialog"]')!.textContent ?? "";
    expect(text).toContain("Workspace: Research.");
    expect(text).not.toContain("workspace-a");
  });

  it("does not replay a confirmed creation that was already opened before this palette open", async () => {
    const opened = {
      state: "confirmed",
      message: "Conversation created and independently verified.",
      mode: "chat",
      sessionId: "s1",
    };
    controls.attempt = opened;
    act(() => root.render(<CommandPalette open={false} onOpenChange={() => undefined} />));
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    await ready();
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain("Conversation created");
    controls.attempt = { ...opened, sessionId: "s2" };
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    await ready();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Conversation created");
  });

  it("keeps an unconfirmed creation visible so it is never retried blindly", async () => {
    controls.attempt = { state: "unknown", message: "Creation outcome is unconfirmed.", mode: "chat" };
    act(() => root.render(<CommandPalette open={false} onOpenChange={() => undefined} />));
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    await ready();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Creation outcome is unconfirmed.");
  });

  it.each(["Enter", " "])("keeps disclosure activation %j separate from the selected New chat command", async (key) => {
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
    await ready();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const selected = dialog.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')!;
    expect(selected.textContent).toMatch(/^New chat/);
    // One disclosure level (SH-26): the source's coverage sits inside the single "Search coverage" disclosure.
    const details = dialog.querySelector('section[aria-label="Conversations search coverage"]')!.closest("details")!;
    const summary = details.querySelector<HTMLElement>(":scope > summary")!;
    expect(details.querySelector("details")).toBeNull();
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
    await ready();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const report = await axe.run(dialog, { runOnly: ["aria-required-children", "aria-required-parent"] });
    expect(report.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ html }) => html) }))).toEqual([]);
    const listbox = dialog.querySelector('[role="listbox"]')!;
    expect(listbox.querySelector("details, summary, [role='status'], [role='alert']")).toBeNull();
    expect(dialog.textContent).toContain("Library unavailable.");
    expect(dialog.querySelector("[role='alert']")?.textContent).toBe("Search didn't respond. Try again.");
    expect(dialog.querySelector("[role='status']")?.textContent?.trim()).toBe("Searching…");
    expect(dialog.textContent).toContain("No matches in the loaded results.");
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

  it("uses the real cmdk input label while keeping the dialog name distinct", async () => {
    act(() => {
      root.render(<CommandPalette open onOpenChange={() => undefined} />);
    });
    await ready();
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

  it("hides command groups with no match instead of stacking empty headings above a record hit", async () => {
    controls.search.groups = [
      {
        id: "library",
        label: "Library capabilities",
        coverage: "Bounded window.",
        items: [
          {
            id: "c1",
            label: "Schedules capability",
            description: "Capability",
            target: { href: "/library/capabilities" },
          },
        ],
      },
    ];
    act(() => root.render(<CommandPalette open onOpenChange={() => undefined} />));
    await ready();
    const input = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "sched");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map((node) => node.textContent);
    expect(headings).toEqual(["Library capabilities"]);
    expect(document.body.textContent).not.toContain("Go to Chat");
    expect(document.body.textContent).toContain("Schedules capability");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "theme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...document.querySelectorAll("[cmdk-group-heading]")].map((node) => node.textContent)).toContain(
      "Preferences",
    );
    expect([...document.querySelectorAll("[cmdk-group-heading]")].map((node) => node.textContent)).not.toContain(
      "Commands",
    );
  });

  it("offers all areas and the classic view", async () => {
    act(() => {
      root.render(<CommandPalette open onOpenChange={() => undefined} />);
    });
    await ready();
    const body = document.body.textContent ?? "";
    for (const label of [
      "Go to Chat",
      "Go to Inbox",
      "Go to Work",
      "Go to Capabilities",
      "Go to Library",
      "Go to System",
      "Switch to classic Mission Control",
    ]) {
      expect(body).toContain(label);
    }
    expect(body).toContain("Switch to compact density");
    expect(body).toContain("Default model: Recorded Model · Local runtime");
    expect(body).toContain("Conversation overrides stay in Chat");
    expect(body).toContain("New chat");
  });

  it("finds Capabilities by the words people use for it", async () => {
    act(() => {
      root.render(<CommandPalette open onOpenChange={() => undefined} />);
    });
    await ready();
    const input = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
    for (const word of ["plugins", "connectors", "mcp", "integrations", "install"]) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, word);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(document.body.textContent, word).toContain("Go to Capabilities");
      expect(document.body.textContent, word).not.toContain("Go to Work");
    }
  });

  it("dispatches explicit owner actions and preserves the guarded classic handoff", async () => {
    const close = vi.fn();
    act(() => {
      root.render(<CommandPalette open onOpenChange={close} />);
    });
    await ready();
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
    expect(controls.navigate).toHaveBeenCalledWith("/settings/models#providers");
    click("Switch to compact density");
    expect(controls.setDensity).toHaveBeenCalledWith("compact");
    // GL-15: the palette offers the theme choices that are not already saved, including Match system.
    expect(document.body.textContent).not.toContain("Use dark theme");
    click("Match system theme");
    expect(controls.setTheme).toHaveBeenCalledWith("system");
    click("Use light theme");
    expect(controls.setTheme).toHaveBeenCalledWith("light");
    click("Switch to classic");
    expect(controls.switchShell).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(false);
  });
});
