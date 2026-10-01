import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ApplicationMount {
  root: Root;
  token: object;
}

// Both lazy entries use this owner. A shell handoff renders into the existing
// React root; it never reloads the document or reinitializes module stores.
const mounts = new WeakMap<HTMLElement, ApplicationMount>();

export function renderApplicationRoot(container: HTMLElement, children: ReactNode): void {
  let mount = mounts.get(container);
  if (!mount) {
    mount = { root: createRoot(container), token: {} };
    mounts.set(container, mount);
  }
  mount.root.render(children);
  mount.token = {};
}

/** An async handoff is valid only while the captured root still owns its view. */
export function captureApplicationRoot(container: HTMLElement): object | undefined {
  return mounts.get(container)?.token;
}

export function isApplicationRootCurrent(container: HTMLElement, token: object): boolean {
  return mounts.get(container)?.token === token;
}
