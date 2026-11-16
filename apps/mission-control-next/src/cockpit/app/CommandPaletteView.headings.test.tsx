// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { expect, it, vi } from "vitest";
import { CommandPaletteView, type CommandPaletteViewProps } from "./CommandPaletteView";

// cmdk measures its list with ResizeObserver and scrolls the selected item into view; happy-dom has neither.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);
Element.prototype.scrollIntoView = () => undefined;

const props: CommandPaletteViewProps = {
  query: "",
  setQuery: () => undefined,
  inputRef: { current: null },
  activeWorkspaceId: "workspace-a",
  workspaceName: "Research",
  creationNotice: null,
  newChatBlocked: false,
  modelSummary: "Recorded model",
  matches: () => true,
  commandMatches: true,
  preferenceMatches: true,
  noMatches: false,
  destinations: [{ key: "inbox", label: "Inbox", path: "/inbox" }],
  settingsMatches: [{ section: "models", label: "Models", href: "/settings/models" }],
  theme: "dark",
  density: "comfortable",
  search: {
    groups: [
      {
        id: "chat",
        label: "Chats",
        items: [{ id: "c1", label: "A chat", description: "Earlier" }],
      },
    ],
    loading: false,
    error: undefined,
    retry: () => undefined,
    retrying: false,
  } as unknown as CommandPaletteViewProps["search"],
  onNewChat: () => undefined,
  onChooseModel: () => undefined,
  onTheme: () => undefined,
  onDensity: () => undefined,
  onClassic: () => undefined,
  onDestination: () => undefined,
  onSetting: () => undefined,
  selectObject: () => undefined,
};

it("every palette group pads its heading like its items (U-GL-040)", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <UiPreferencesProvider>
        <CommandPaletteView {...props} />
      </UiPreferencesProvider>,
    );
  });
  try {
    const groups = [...container.querySelectorAll("[cmdk-group]")];
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) expect(group.className).toContain("[&_[cmdk-group-heading]]:px-3");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
