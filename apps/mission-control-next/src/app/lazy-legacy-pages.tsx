import { lazy } from "react";

export const LazyThreadedSurfaceRoute = lazy(async () => {
  const module = await import("@next/features/threaded-surface/ThreadedSurfaceRoute");
  return { default: module.ThreadedSurfaceRoute };
});

export const LazyPromptPacksWorkbenchPage = lazy(async () => {
  const module = await import("@next/features/prompt-packs/PromptPacksWorkbenchPage");
  return { default: module.PromptPacksWorkbenchPage };
});

export const LazyNativeRoutePages = lazy(async () => {
  const module = await import("@next/features/native-routes/NativeRoutePages");
  return { default: module.NativeRoutePages };
});
