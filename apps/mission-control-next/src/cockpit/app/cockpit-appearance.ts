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
  root.dataset.theme = theme === "light" ? "light" : "dark";
  root.dataset.density = density === "compact" ? "compact" : "comfortable";
}
