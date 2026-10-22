/**
 * Applies the resolved theme and saved density to the document root. The access gate and the shell
 * both call this, so "Connecting…" and "Can't reach the gateway" follow the operator's theme
 * instead of rendering in the light default before the shell mounts.
 * Callers pass `useUiPreferences().theme`, which already resolves Match system from `prefers-color-scheme`;
 * anything other than "light" paints dark so an unresolved value never reaches `data-theme`.
 * Shell ownership (`data-shell`) stays with CockpitShell.
 */
export function applyCockpitAppearance(theme: string, density: string | undefined): void {
  const root = document.documentElement;
  const resolved = theme === "light" ? "light" : "dark";
  root.dataset.theme = resolved;
  root.dataset.density = density === "compact" ? "compact" : "comfortable";
  // index.html's theme-color tags follow the OS scheme for the first paint; from here the browser chrome follows the
  // chosen theme's --cockpit-canvas, so a saved, ?theme= or runtime choice wins over the OS scheme.
  for (const chrome of document.querySelectorAll('meta[name="theme-color"]'))
    chrome.setAttribute("content", BROWSER_CHROME[resolved]);
}

/** --cockpit-canvas per theme, as in index.html. */
const BROWSER_CHROME = { light: "#f0f8ff", dark: "#122235" } as const;
