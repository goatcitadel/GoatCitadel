import type { ReactNode } from "react";

export type KbdHintProps = {
  /**
   * Keys to render. Strings get wrapped in <kbd>. ReactNodes pass through
   * for cases like Lucide icons (Cmd, Shift, etc.).
   * Example: <KbdHint keys={["Cmd", "K"]} />
   * Example: <KbdHint keys={[<Cmd />, "K"]} />
   */
  keys: ReactNode[];
  /** Optional label rendered before the keys, e.g. "Open palette". */
  label?: ReactNode;
  /** Visual size — "sm" pairs with body copy; "md" pairs with controls. */
  size?: "sm" | "md";
  /** Inline display (default) or block — block adds vertical breathing room. */
  display?: "inline" | "block";
};

/**
 * Display-only keyboard-shortcut hint. Use to label affordances such as
 * "Press <Cmd>+<K>" in palettes, menus, or onboarding copy. NOT a control —
 * for actual keyboard handling, wire useShellKeyboardManager or its peers.
 *
 * Filed against H-7 (ship punchlist) to support the shell keyboard model
 * landing alongside the Cmd+K command palette.
 */
export function KbdHint({ keys, label, size = "sm", display = "inline" }: KbdHintProps) {
  return (
    <span className="mc-next-kbd-hint" data-size={size} data-display={display}>
      {label !== undefined ? <span className="mc-next-kbd-hint-label">{label}</span> : null}
      <span className="mc-next-kbd-hint-keys" aria-hidden={label !== undefined ? undefined : "false"}>
        {keys.map((key, index) => (
          <span key={index} className="mc-next-kbd-hint-key-cell">
            {typeof key === "string" ? <kbd>{key}</kbd> : key}
            {index < keys.length - 1 ? (
              <span className="mc-next-kbd-hint-sep" aria-hidden="true">
                +
              </span>
            ) : null}
          </span>
        ))}
      </span>
    </span>
  );
}
