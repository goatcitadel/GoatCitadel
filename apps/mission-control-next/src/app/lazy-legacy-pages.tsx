import { lazy } from "react";

const loadThreadedSurfaceRoute = () => import("@next/features/threaded-surface/ThreadedSurfaceRoute");
const loadPromptPacksWorkbenchPage = () => import("@next/features/prompt-packs/PromptPacksWorkbenchPage");
const loadNativeRoutePages = () => import("@next/features/native-routes/NativeRoutePages");

export function preloadThreadedSurfaceRoute(): Promise<unknown> {
  return loadThreadedSurfaceRoute();
}

export const LazyThreadedSurfaceRoute = lazy(async () => {
  const module = await loadThreadedSurfaceRoute();
  return { default: module.ThreadedSurfaceRoute };
});

export const LazyPromptPacksWorkbenchPage = lazy(async () => {
  const module = await loadPromptPacksWorkbenchPage();
  return { default: module.PromptPacksWorkbenchPage };
});

export const LazyNativeRoutePages = lazy(async () => {
  const module = await loadNativeRoutePages();
  return { default: module.NativeRoutePages };
});
