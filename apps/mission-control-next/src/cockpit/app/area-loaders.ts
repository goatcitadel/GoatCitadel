import { canPreload, preloadable } from "./preloadable";
import type { CockpitArea } from "./routes";

export const SettingsArea = preloadable(async () => ({ default: (await import("../areas/settings/SettingsArea")).SettingsArea }));
export const InboxArea = preloadable(async () => ({ default: (await import("../areas/inbox/InboxArea")).InboxArea }));
export const WorkArea = preloadable(async () => ({ default: (await import("../areas/work/WorkArea")).WorkArea }));
export const LibraryArea = preloadable(async () => ({ default: (await import("../areas/library/LibraryArea")).LibraryArea }));
export const SystemArea = preloadable(async () => ({ default: (await import("../areas/system/SystemArea")).SystemArea }));
export const Gallery = preloadable(async () => ({ default: (await import("./Gallery")).Gallery }));

const LOADERS = { inbox: InboxArea, work: WorkArea, library: LibraryArea, system: SystemArea, settings: SettingsArea, gallery: Gallery };

export function preloadCockpitArea(area: CockpitArea): void {
  if (!canPreload()) return;
  if (area !== "chat") void LOADERS[area].preload();
  if (area === "settings") {
    void import("../areas/settings/settings-controls").then((controls) => controls.preloadSettingsSection("general"), () => undefined);
  }
}
