import { createElement, use, type ComponentType } from "react";

/** Speculation is optional; actual navigation always loads its destination. */
export function canPreload(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return navigator.onLine !== false && !connection?.saveData
    && connection?.effectiveType !== "slow-2g" && connection?.effectiveType !== "2g";
}

/** Share the import between intent and render, without caching a speculative failure. */
export function preloadable<Props extends object>(loader: () => Promise<{ default: ComponentType<Props> }>) {
  let pending: Promise<{ default: ComponentType<Props> }> | undefined;
  let resolved: { default: ComponentType<Props> } | undefined;
  let renderRequested = false;
  const load = () => pending ??= loader().then((module) => { resolved = module; return module; });
  function Component(props: Props) {
    renderRequested = true;
    // A completed warm import renders synchronously, without a first-use fallback.
    const module = resolved ?? use(load());
    return createElement(module.default, props);
  }
  return Object.assign(Component, {
    preload: () => {
      if (!canPreload()) return Promise.resolve();
      const warm = load();
      return warm.then(() => undefined, () => {
        if (!renderRequested && pending === warm) pending = undefined;
      });
    },
  });
}
