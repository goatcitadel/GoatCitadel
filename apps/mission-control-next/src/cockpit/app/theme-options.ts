import type { UiTheme } from "@goatcitadel/mission-control-shared/state/ui-preferences";

export interface ThemeOption {
  value: UiTheme;
  /** Short choice label for selects and segmented controls. */
  label: string;
  /** Imperative label for menus and the command palette. */
  action: string;
}

/** GL-15: every theme control offers the same three choices, in this order. */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: "light", label: "Light", action: "Use light theme" },
  { value: "dark", label: "Dark", action: "Use dark theme" },
  { value: "system", label: "Match system", action: "Match system theme" },
];

/** The choices a quick toggle offers: every option except the one already saved. */
export function otherThemeOptions(current: UiTheme): readonly ThemeOption[] {
  return THEME_OPTIONS.filter((option) => option.value !== current);
}

/** Command palette search text for the theme choices. */
export const THEME_SEARCH_TERMS = "Switch theme light dark match system";
