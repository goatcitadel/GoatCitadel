// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const imports = vi.hoisted(() => ({
  inbox: vi.fn(),
  work: vi.fn(),
  library: vi.fn(),
  system: vi.fn(),
  gallery: vi.fn(),
  chatUnmount: vi.fn(),
}));
const preferences = vi.hoisted(() => ({ theme: "dark", density: "comfortable", activeWorkspaceId: "workspace-1" }));
const mobile = vi.hoisted(() => ({ wide: true, imported: vi.fn(), held: undefined as Promise<void> | undefined }));
vi.mock("../areas/chat/ChatArea", () => ({
  ChatArea: () => {
    useEffect(() => imports.chatUnmount, []);
    return <div>Chat ready<input aria-label="Chat draft" defaultValue="" /></div>;
  },
}));
vi.mock("../areas/inbox/InboxArea", () => {
  imports.inbox();
  return { InboxArea: () => <div>Inbox loaded</div> };
});
vi.mock("../areas/work/WorkArea", () => {
  imports.work();
  return { WorkArea: () => <div>Work loaded</div> };
});
vi.mock("../areas/library/LibraryArea", () => {
  imports.library();
  return { LibraryArea: () => <div>Library loaded</div> };
});
vi.mock("../areas/system/SystemArea", () => {
  imports.system();
  return { SystemArea: () => <div>System loaded</div> };
});
vi.mock("./Gallery", () => {
  imports.gallery();
  return { Gallery: () => <div>Gallery loaded</div> };
});
vi.mock("./Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./MobileTabBar", async () => {
  mobile.imported();
  await mobile.held;
  return { MobileTabBar: () => <nav aria-label="Loaded mobile areas" /> };
});
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./inspector", () => ({
  InspectorProvider: ({ children }: { children: React.ReactNode }) => children,
  InspectorPanel: () => null,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => preferences,
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => mobile.wide }));

it("keeps Chat immediate and loads only the requested cockpit area", async () => {
  const { CockpitShell } = await import("./CockpitShell");
  for (const load of Object.values(imports)) expect(load).not.toHaveBeenCalled();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    window.history.replaceState(null, "", "/chat");
    act(() => root.render(<CockpitShell />));
    expect(container.textContent).toContain("Chat ready");
    expect(mobile.imported).not.toHaveBeenCalled();
    for (const load of Object.values(imports)) expect(load).not.toHaveBeenCalled();
    const draft = container.querySelector<HTMLInputElement>('input[aria-label="Chat draft"]')!;
    draft.value = "Keep this draft";

    await act(async () => {
      window.history.pushState(null, "", "/work");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await vi.dynamicImportSettled();
    });
    expect(imports.chatUnmount).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Work loaded");
    expect(imports.work).toHaveBeenCalledOnce();
    expect(imports.library).not.toHaveBeenCalled();

    await act(async () => {
      window.history.pushState(null, "", "/library");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await vi.dynamicImportSettled();
    });
    expect(container.textContent).toContain("Library loaded");
    expect(imports.library).toHaveBeenCalledOnce();
    expect(imports.inbox).not.toHaveBeenCalled();
    expect(imports.system).not.toHaveBeenCalled();
    expect(imports.gallery).not.toHaveBeenCalled();

    act(() => {
      window.history.pushState(null, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(container.querySelector('input[aria-label="Chat draft"]')).toBe(draft);
    expect(draft.value).toBe("Keep this draft");
    expect(draft.closest("div")?.style.display).not.toBe("none");
    expect(container.querySelector('[role="status"]')).toBeNull();

    preferences.activeWorkspaceId = "workspace-2";
    act(() => root.render(<CockpitShell />));
    const nextDraft = container.querySelector<HTMLInputElement>('input[aria-label="Chat draft"]')!;
    expect(nextDraft).not.toBe(draft);
    expect(nextDraft.value).toBe("");

    let release!: () => void;
    mobile.held = new Promise<void>((resolve) => { release = resolve; });
    mobile.wide = false;
    act(() => root.render(<CockpitShell />));
    expect(container.querySelector('[aria-label="Areas on small screens"] a[href*="/chat"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Loaded mobile areas"]')).toBeNull();
    await act(async () => {
      release();
      await vi.dynamicImportSettled();
    });
    expect(mobile.imported).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Loaded mobile areas"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
