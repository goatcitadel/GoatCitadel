export type DrawerContent = typeof import("vaul").Drawer.Content;
type SheetDrawerRuntime = typeof import("./SheetDrawerRuntime").SheetDrawerRuntime;
// A scope-neutral code cache only. Public children and their state mount once the SDK is ready.
let drawerLoad: Promise<SheetDrawerRuntime> | undefined;
let loadedDrawer: SheetDrawerRuntime | undefined;
export function loadDrawer() {
  drawerLoad ??= import("./SheetDrawerRuntime").then(({ SheetDrawerRuntime }) => (loadedDrawer = SheetDrawerRuntime));
  return drawerLoad;
}

export function readLoadedDrawer() {
  return loadedDrawer;
}
