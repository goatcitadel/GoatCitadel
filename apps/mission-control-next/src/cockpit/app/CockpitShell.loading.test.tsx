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
vi.mock("../areas/chat/ChatArea", () => ({
  ChatArea: () => {
    useEffect(() => imports.chatUnmount, []);
    return <div>Chat ready</div>;
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
vi.mock("./MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./inspector", () => ({
  InspectorProvider: ({ children }: { children: React.ReactNode }) => children,
  InspectorPanel: () => null,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ theme: "dark", density: "comfortable" }),
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

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
    for (const load of Object.values(imports)) expect(load).not.toHaveBeenCalled();

    act(() => {
      window.history.pushState(null, "", "/work");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading Work…");
    expect(imports.chatUnmount).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.dynamicImportSettled();
    });
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
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
