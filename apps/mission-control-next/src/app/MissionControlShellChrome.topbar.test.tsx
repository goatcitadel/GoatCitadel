import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ShellRail } from "./MissionControlShellChrome";
import { AREA_META } from "./route-model";
describe("Unified sidebar scope selectors", () => {
  it("keeps both scope selectors named and functional in their sidebar destination", () => {
    const handleSelectCitadel = vi.fn();
    const handleSelectWorkspace = vi.fn();
    const renderer = TestRenderer.create(<ShellRail activeCitadelId="personal" activeCitadelName="Personal"
      activeWorkspaceId="workspace-1" activeWorkspaceName="Workspace One" buildPrimaryAreaRoute={(area) => ({ area })}
      citadelOptions={[{citadelId:"personal",name:"Personal"}]} workspaceOptions={[{workspaceId:"workspace-1",name:"Workspace One"}]}
      handleSelectCitadel={handleSelectCitadel} handleSelectWorkspace={handleSelectWorkspace} currentAreaMeta={AREA_META.settings}
      groupedRailItems={[]} isMobileNav={false} navOpen={true} navigate={vi.fn()} onClose={vi.fn()} onOpenPalette={vi.fn()}
      pendingApprovals={0} preloadRouteChunk={vi.fn()} railSignalLines={[]} railSignalTitle="Runtime" route={{area:"settings",section:"providers"}} taskBacklogCount={0} />);
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
