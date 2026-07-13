import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { ShellTopbar } from "./MissionControlShellChrome";

describe("ShellTopbar scope selectors", () => {
  it("gives both desktop scope selectors explicit accessible names", () => {
    const handleSelectCitadel = vi.fn();
    const handleSelectWorkspace = vi.fn();
    const renderer = TestRenderer.create(
      <ShellTopbar
        activeCitadelId="personal"
        activeCitadelName="Personal"
        activeWorkspaceId="workspace-1"
        activeWorkspaceName="Workspace One"
        buildPrimaryAreaRoute={(area) => ({ area })}
        citadelOptions={[{ citadelId: "personal", name: "Personal" }]}
        handleOpenStartHere={vi.fn()}
        handleSelectCitadel={handleSelectCitadel}
        handleSelectWorkspace={handleSelectWorkspace}
        handleToggleMode={vi.fn()}
        handleToggleNotificationSound={vi.fn()}
        handleToggleTheme={vi.fn()}
        inspectorAvailable={false}
        inspectorOpen={false}
        isCompactTopbar={false}
        mode="simple"
        navigate={vi.fn()}
        onOpenPalette={vi.fn()}
        onOpenNav={vi.fn()}
        onToggleInspector={vi.fn()}
        operatorNotificationCount={0}
        pendingApprovals={0}
        preloadRouteChunk={vi.fn()}
        realtimeBadge="Live"
        realtimeDegraded={false}
        route={{ area: "chat" }}
        soundEnabled={false}
        theme="dark"
        workspaceOptions={[{ workspaceId: "workspace-1", name: "Workspace One" }]}
      />,
    );

    const citadelSelect = renderer.root.findByProps({ "aria-label": "Active Citadel" });
    const workspaceSelect = renderer.root.findByProps({ "aria-label": "Active Workspace" });
    expect(citadelSelect.type).toBe("select");
    expect(workspaceSelect.type).toBe("select");

    TestRenderer.act(() => {
      citadelSelect.props.onChange({ target: { value: "company" } });
      workspaceSelect.props.onChange({ target: { value: "workspace-2" } });
    });
    expect(handleSelectCitadel).toHaveBeenCalledWith("company");
    expect(handleSelectWorkspace).toHaveBeenCalledWith("workspace-2");
  });
});
