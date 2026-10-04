/**
 * Applies the saved theme and density to the document root. The access gate and the shell
 * both call this, so "Connecting…" and "Can't reach the gateway" follow a dark preference
 * instead of rendering in the light default before the shell mounts.
 * Shell ownership (`data-shell`) stays with CockpitShell.
 */
export function applyCockpitAppearance(theme: string, density: string | undefined): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.density = density === "compact" ? "compact" : "comfortable";
}
