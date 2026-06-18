import { Suspense, createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@next/features/threaded-surface/ThreadedSurfaceRoute", () => ({
  ThreadedSurfaceRoute: () => createElement("div", { className: "lazy-threaded" }, "Threaded lazy"),
}));

vi.mock("@next/features/prompt-packs/PromptPacksWorkbenchPage", () => ({
  PromptPacksWorkbenchPage: () => createElement("div", { className: "lazy-prompt-packs" }, "Prompt packs lazy"),
}));

vi.mock("@next/features/native-routes/NativeRoutePages", () => ({
  NativeRoutePages: () => createElement("div", { className: "lazy-native" }, "Native lazy"),
}));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("lazy legacy page adapters", () => {
  it("preloads and resolves lazy route modules to their named exports", async () => {
    const {
      LazyNativeRoutePages,
      LazyPromptPacksWorkbenchPage,
      LazyThreadedSurfaceRoute,
      preloadNativeRoutePages,
      preloadPromptPacksWorkbenchPage,
      preloadThreadedSurfaceRoute,
    } = await import("./lazy-legacy-pages");

    await expect(preloadThreadedSurfaceRoute()).resolves.toMatchObject({
      ThreadedSurfaceRoute: expect.any(Function),
    });
    await expect(preloadPromptPacksWorkbenchPage()).resolves.toMatchObject({
      PromptPacksWorkbenchPage: expect.any(Function),
    });
    await expect(preloadNativeRoutePages()).resolves.toMatchObject({
      NativeRoutePages: expect.any(Function),
    });

    const renderer = create(
      createElement(
        Suspense,
        { fallback: createElement("span", null, "loading") },
        createElement(LazyThreadedSurfaceRoute, {
          surface: "chat",
          workspaceId: "workspace-1",
          workspaceName: "Workspace One",
          approvalsCount: 0,
        }),
        createElement(LazyPromptPacksWorkbenchPage, {
          variant: "library",
          workspaceId: "workspace-1",
          navigate: () => undefined,
        }),
        createElement(LazyNativeRoutePages, {
          route: { area: "ops" },
          activeWorkspaceId: "workspace-1",
          activeWorkspaceName: "Workspace One",
          pendingApprovals: 0,
          navigate: () => undefined,
          setActiveWorkspaceId: () => undefined,
        }),
      ),
    );
    await flush();

    expect(JSON.stringify(renderer.toJSON())).toContain("Threaded lazy");
    expect(JSON.stringify(renderer.toJSON())).toContain("Prompt packs lazy");
    expect(JSON.stringify(renderer.toJSON())).toContain("Native lazy");
  });
});
