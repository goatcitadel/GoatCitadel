export const INSPECTOR_MIN_WIDTH = 360;
export const INSPECTOR_MAX_WIDTH = 560;
export function clampInspectorWidth(value: number) {
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, value));
}

/**
 * The docked inspector's width per area, remembered in this browser. It is a cockpit-local presentation preference,
 * so a storage failure or an unreadable value falls back to the default width without an error.
 */
const STORAGE_KEY = "goatcitadel.cockpit.inspector.width.v1";
export const INSPECTOR_DEFAULT_WIDTH = 384;

function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The remembered width for the area, or the default when none was saved, storage is unavailable or the value is out of range. */
export function readInspectorWidth(area: string): number {
  const value = readAll()[area];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= INSPECTOR_MIN_WIDTH &&
    value <= INSPECTOR_MAX_WIDTH
    ? value
    : INSPECTOR_DEFAULT_WIDTH;
}

/** Remembers the width, clamped to the allowed range. When storage is unavailable the width still applies for this visit. */
export function writeInspectorWidth(area: string, width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [area]: clampInspectorWidth(width) }));
  } catch {
    return;
  }
}
