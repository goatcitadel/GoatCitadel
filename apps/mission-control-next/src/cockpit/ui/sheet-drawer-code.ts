export type DrawerModule = typeof import("vaul");
export type DrawerContent = DrawerModule["Drawer"]["Content"];
// A scope-neutral code cache only. Public children and their state mount once the SDK is ready.
let drawerLoad: Promise<DrawerModule> | undefined;
let loadedDrawer: DrawerModule | undefined;
export function loadDrawer() {
  drawerLoad ??= import("vaul").then((code) => {
    loadedDrawer = code;
    return code;
  });
  return drawerLoad;
}

export function readLoadedDrawer() {
  return loadedDrawer;
}
