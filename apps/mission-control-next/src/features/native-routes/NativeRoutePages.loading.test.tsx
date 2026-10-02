import { Suspense } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { NativeRoutePagesProps } from "./types";

const imports = vi.hoisted(() => ({ projects: vi.fn(), runtime: vi.fn() }));
vi.mock("./projects/ProjectsRoutePage", () => {
  imports.projects();
  return { ProjectsRoutePage: () => <div>Projects loaded</div> };
});
vi.mock("./ops/RuntimeRoutePage", () => {
  imports.runtime();
  return { RuntimeRoutePage: () => <div>Runtime loaded</div> };
});

describe("NativeRoutePages cold loading", () => {
  it("loads only the selected page and keeps a loading fallback available", async () => {
    const { NativeRoutePages } = await import("./NativeRoutePages");
    expect(imports.projects).not.toHaveBeenCalled();
    expect(imports.runtime).not.toHaveBeenCalled();
    const props: NativeRoutePagesProps = {
      route: { area: "projects" },
      activeWorkspaceId: "default",
      activeWorkspaceName: "Default",
      pendingApprovals: 0,
      navigate: vi.fn(),
      setActiveWorkspaceId: vi.fn(),
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <Suspense fallback={<div>Loading page</div>}>
          <NativeRoutePages {...props} />
        </Suspense>,
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Loading page");
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Projects loaded");
    expect(imports.projects).toHaveBeenCalledOnce();
    expect(imports.runtime).not.toHaveBeenCalled();
    await act(async () => {
      renderer.update(
        <Suspense fallback={<div>Loading page</div>}>
          <NativeRoutePages {...props} route={{ area: "ops" }} />
        </Suspense>,
      );
      await vi.dynamicImportSettled();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Runtime loaded");
    expect(imports.runtime).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });
});
