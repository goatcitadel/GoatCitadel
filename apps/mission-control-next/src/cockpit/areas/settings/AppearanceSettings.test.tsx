// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { AppearanceSettings } from "./AppearanceSettings";

vi.mock("../../../features/native-routes/settings/use-desktop-notifications", () => ({
  describeDesktopPermission: () => "System notifications are not allowed yet.",
  useDesktopNotifications: () => ({
    desktopPermission: "default",
    checkingPermission: false,
    checkDesktopPermission: vi.fn(),
    sendTestNotification: vi.fn(),
    notificationFeedback: null,
  }),
}));
vi.mock("./DesktopUpdateSettings", () => ({ DesktopUpdateSettings: () => null }));
const routing = vi.hoisted(() => ({ workspaces: [] as string[] }));
vi.mock("./AttentionNotificationRouting", () => ({
  AttentionNotificationRouting: ({ workspaceId }: { workspaceId: string }) => {
    routing.workspaces.push(workspaceId);
    return <section aria-label="Notification routing" />;
  },
}));

let view: ReactTestRenderer;
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const select = (label: string) =>
  view.root
    .findAll((node) => node.type === "select" && node.props.id !== undefined)
    .find((node) => {
      const labelNode = view.root.findAll(
        (candidate) => candidate.type === "label" && candidate.props.htmlFor === node.props.id,
      );
      return labelNode.some((candidate) => text(candidate).includes(label));
    })!;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", "workspace-7");
  routing.workspaces.length = 0;
});
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  vi.useRealTimers();
});

async function mount() {
  await act(async () => {
    view = create(
      <UiPreferencesProvider>
        <AppearanceSettings />
      </UiPreferencesProvider>,
    );
  });
}

describe("General › Appearance and attention", () => {
  it("GL-15 / ST-25: offers Light, Dark and Match system, defaulting to Match system", async () => {
    await mount();
    const theme = select("Color theme");
    expect(theme.props.value).toBe("system");
    expect(theme.findAllByType("option").map((option) => [option.props.value, text(option)])).toEqual([
      ["light", "Light"],
      ["dark", "Dark"],
      ["system", "Match system"],
    ]);
    expect(text(view.root)).not.toContain("Bright sky");
    expect(text(view.root)).not.toContain("Lifted navy");
    await act(async () => theme.props.onChange({ target: { value: "dark" } }));
    expect(window.localStorage.getItem("goatcitadel.ui.theme.v1")).toBe("dark");
    expect(select("Color theme").props.value).toBe("dark");
  });

  it("ST-16: says changes save automatically and briefly confirms the last change without a new live region", async () => {
    await mount();
    const note = view.root.findByProps({ "data-settings-save-model": "automatic" });
    expect(text(note)).toContain("Saved automatically");
    expect(note.props.role).toBeUndefined();
    const liveRegions = () =>
      view.root.findAll((node) => node.props.role === "status" || node.props.role === "alert").length;
    const before = liveRegions();
    await act(async () => select("Density").props.onChange({ target: { value: "compact" } }));
    expect(text(note)).toContain("Density saved.");
    expect(liveRegions()).toBe(before);
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(text(view.root.findByProps({ "data-settings-save-model": "automatic" }))).not.toContain("Density saved.");
  });

  it("ST-09: renders notification routing beside Attention for the active workspace", async () => {
    await mount();
    expect(view.root.findAllByProps({ "aria-label": "Notification routing" })).toHaveLength(1);
    expect(routing.workspaces.at(-1)).toBe("workspace-7");
  });
});
