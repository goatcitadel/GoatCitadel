import * as React from "react";

/**
 * Preview provider for design-sync (NOT a product component).
 *
 * mission-control-next's component styling relies on CSS custom properties
 * declared on the theme class `.theme-citadel-light` (see
 * mission-control-next-theme-bridge.css) — `--background`, `--foreground`,
 * `--primary`, `--border`, the `--surface`/`--panel`/`--text` families, etc.
 * Without a `.theme-*` ancestor those vars are undefined and components render
 * with the wrong (or missing) colors.
 *
 * Two scopes:
 *  - the wrapper <div> carries the theme for normal in-flow components;
 *  - a layout effect also adds the class to <html>, so Radix-PORTALED content
 *    (GCModal dialog, GCCombobox popover) — which renders on document.body,
 *    outside this div — still inherits the theme-bridge vars. theme-bridge.css
 *    declares the aliases on the bare `.theme-*` class precisely for this.
 *
 * It deliberately does NOT add `.mc-next-shell` (that class forces
 * `min-height: 100dvh` + app-shell grid, which would blow up every card).
 */
export function ThemeWrapper({ children }: { children?: React.ReactNode }) {
  React.useLayoutEffect(() => {
    // Add-only (no cleanup): in the grid view multiple cells mount their own
    // wrapper; a cleanup that removed the class would strip it from html while
    // sibling cells are still mounted.
    document.documentElement.classList.add("theme-citadel-light");
  }, []);
  return (
    <div
      className="theme-citadel-light"
      data-area="chat"
      style={{
        padding: 24,
        background: "var(--bg-app)",
        color: "var(--fg-primary)",
        fontFamily: "var(--font-sans)",
        borderRadius: 8,
        position: "relative",
      }}
    >
      {children}
    </div>
  );
}
