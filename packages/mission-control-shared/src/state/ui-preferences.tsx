import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UiEffectsMode } from "./effects-mode";
import type { OperatorAttentionSoundMode } from "./operator-attention";
import type { ShellNavMode } from "../components/ShellNavRail";

export type UiExperienceMode = "simple" | "advanced";
export type UiDensity = "comfortable" | "default" | "compact";
/** The saved theme choice. `system` follows `prefers-color-scheme` live and is the default when nothing is saved. */
export type UiTheme = "dark" | "light" | "system";
/** The theme actually painted after resolving `system`. */
export type UiResolvedTheme = "dark" | "light";

export interface UiNotificationPreferences {
  toastsEnabled: boolean;
  soundMode: OperatorAttentionSoundMode;
  desktopEnabled: boolean;
  onlyWhenUnfocused: boolean;
}

interface UiPreferencesValue {
  /** Advances synchronously on scope intent, including batched away/back transitions. */
  scopeGenerationRef?: { readonly current: number };
  /** Committed scope revision also publishes batched away/back changes to consumers. */
  scopeGeneration?: number;
  mode: UiExperienceMode;
  setMode: (mode: UiExperienceMode) => void;
  density: UiDensity;
  setDensity: (density: UiDensity) => void;
  effectsMode: UiEffectsMode;
  setEffectsMode: (mode: UiEffectsMode) => void;
  navMode: ShellNavMode;
  setNavMode: (mode: ShellNavMode) => void;
  showTechnicalDetails: boolean;
  setShowTechnicalDetails: (enabled: boolean) => void;
  detailPanelPinned: boolean;
  setDetailPanelPinned: (enabled: boolean) => void;
  statusCenterExpanded: boolean;
  setStatusCenterExpanded: (enabled: boolean) => void;
  activeCitadelId: string;
  setActiveCitadelId: (citadelId: string) => void;
  activeWorkspaceId: string;
  setActiveWorkspaceId: (workspaceId: string) => void;
  setActiveScope: (scope: { citadelId: string; workspaceId: string }) => void;
  /** The painted theme with `system` resolved, so `theme === "dark"` consumers (Classic included) keep working. */
  theme: UiResolvedTheme;
  /** The saved choice, including `system`. */
  themePreference: UiTheme;
  setTheme: (theme: UiTheme) => void;
  notifications: UiNotificationPreferences;
  setNotificationToastsEnabled: (enabled: boolean) => void;
  setNotificationSoundMode: (mode: OperatorAttentionSoundMode) => void;
  setNotificationDesktopEnabled: (enabled: boolean) => void;
  setNotificationOnlyWhenUnfocused: (enabled: boolean) => void;
}

const MODE_KEY = "goatcitadel.ui.mode.v1";
const DENSITY_KEY = "goatcitadel.ui.density.v1";
const EFFECTS_MODE_KEY = "goatcitadel.ui.effects_mode.v1";
const NAV_MODE_KEY = "goatcitadel.ui.nav_mode.v1";
const DETAILS_KEY = "goatcitadel.ui.technical_details.v1";
const DETAIL_PANEL_PINNED_KEY = "goatcitadel.ui.detail_panel_pinned.v1";
const STATUS_CENTER_EXPANDED_KEY = "goatcitadel.ui.status_center_expanded.v1";
const CITADEL_KEY = "goatcitadel.ui.citadel_id.v1";
const WORKSPACE_KEY = "goatcitadel.ui.workspace_id.v1";
const THEME_KEY = "goatcitadel.ui.theme.v1";
const NOTIFICATION_TOASTS_KEY = "goatcitadel.notifications.toasts.v1";
const NOTIFICATION_SOUND_MODE_KEY = "goatcitadel.notifications.sound_mode.v1";
const NOTIFICATION_DESKTOP_KEY = "goatcitadel.notifications.desktop.v1";
const NOTIFICATION_ONLY_UNFOCUSED_KEY = "goatcitadel.notifications.only_unfocused.v1";

const UiPreferencesContext = createContext<UiPreferencesValue>({
  mode: "simple",
  setMode: () => {},
  density: "default",
  setDensity: () => {},
  effectsMode: "auto",
  setEffectsMode: () => {},
  navMode: "compact",
  setNavMode: () => {},
  showTechnicalDetails: false,
  setShowTechnicalDetails: () => {},
  detailPanelPinned: false,
  setDetailPanelPinned: () => {},
  statusCenterExpanded: false,
  setStatusCenterExpanded: () => {},
  activeCitadelId: "personal",
  setActiveCitadelId: () => {},
  activeWorkspaceId: "default",
  setActiveWorkspaceId: () => {},
  setActiveScope: () => {},
  theme: "dark",
  themePreference: "system",
  setTheme: () => {},
  notifications: {
    toastsEnabled: true,
    soundMode: "off",
    desktopEnabled: false,
    onlyWhenUnfocused: false,
  },
  setNotificationToastsEnabled: () => {},
  setNotificationSoundMode: () => {},
  setNotificationDesktopEnabled: () => {},
  setNotificationOnlyWhenUnfocused: () => {},
});

export function UiPreferencesProvider(props: { children: ReactNode }) {
  const [mode, setModeState] = useState<UiExperienceMode>(() => readModeFromStorage());
  const [density, setDensityState] = useState<UiDensity>(() => readDensityFromStorage());
  const [effectsMode, setEffectsModeState] = useState<UiEffectsMode>(() => readEffectsModeFromStorage());
  const [navMode, setNavModeState] = useState<ShellNavMode>(() => readNavModeFromStorage());
  const [showTechnicalDetails, setShowTechnicalDetailsState] = useState<boolean>(() => readDetailsFromStorage());
  const [detailPanelPinned, setDetailPanelPinnedState] = useState<boolean>(() => readDetailPanelPinnedFromStorage());
  const [statusCenterExpanded, setStatusCenterExpandedState] = useState<boolean>(() =>
    readStatusCenterExpandedFromStorage(),
  );
  const [activeCitadelId, setActiveCitadelIdState] = useState<string>(() => readCitadelIdFromStorage());
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string>(() => readWorkspaceIdFromStorage());
  const scopeGenerationRef = useRef(0);
  const [scopeGeneration, setScopeGeneration] = useState(0);
  const scopeIntentRef = useRef({ citadelId: activeCitadelId, workspaceId: activeWorkspaceId });
  const advanceScopeIntent = useCallback((next: { citadelId: string; workspaceId: string }) => {
    const prior = scopeIntentRef.current;
    if (prior.citadelId === next.citadelId && prior.workspaceId === next.workspaceId) return;
    scopeIntentRef.current = next;
    scopeGenerationRef.current += 1;
    setScopeGeneration(scopeGenerationRef.current);
  }, []);
  const [themePreference, setThemeState] = useState<UiTheme>(() => readThemeFromStorage());
  const systemTheme = useSystemColorScheme(themePreference === "system");
  const theme: UiResolvedTheme = themePreference === "system" ? systemTheme : themePreference;
  const [notifications, setNotificationsState] = useState<UiNotificationPreferences>(() =>
    readNotificationPreferencesFromStorage(),
  );
  const setActiveCitadelId = useCallback(
    (citadelId: string) => {
      const normalized = normalizeCitadelId(citadelId);
      advanceScopeIntent({ ...scopeIntentRef.current, citadelId: normalized });
      setActiveCitadelIdState(normalized);
      writeStorage(CITADEL_KEY, normalized);
    },
    [advanceScopeIntent],
  );
  const setActiveWorkspaceId = useCallback(
    (workspaceId: string) => {
      const normalized = normalizeWorkspaceId(workspaceId);
      advanceScopeIntent({ ...scopeIntentRef.current, workspaceId: normalized });
      setActiveWorkspaceIdState(normalized);
      writeStorage(WORKSPACE_KEY, normalized);
    },
    [advanceScopeIntent],
  );
  const setActiveScope = useCallback(
    (scope: { citadelId: string; workspaceId: string }) => {
      const normalizedCitadelId = normalizeCitadelId(scope.citadelId);
      const normalizedWorkspaceId = normalizeWorkspaceId(scope.workspaceId);
      advanceScopeIntent({ citadelId: normalizedCitadelId, workspaceId: normalizedWorkspaceId });
      setActiveCitadelIdState(normalizedCitadelId);
      setActiveWorkspaceIdState(normalizedWorkspaceId);
      writeStorage(CITADEL_KEY, normalizedCitadelId);
      writeStorage(WORKSPACE_KEY, normalizedWorkspaceId);
    },
    [advanceScopeIntent],
  );

  const value = useMemo<UiPreferencesValue>(
    () => ({
      scopeGenerationRef,
      scopeGeneration,
      mode,
      setMode: (nextMode) => {
        setModeState(nextMode);
        writeStorage(MODE_KEY, nextMode);
        const nextShowDetails = nextMode === "advanced";
        setShowTechnicalDetailsState(nextShowDetails);
        writeStorage(DETAILS_KEY, String(nextShowDetails));
      },
      density,
      setDensity: (nextDensity) => {
        setDensityState(nextDensity);
        writeStorage(DENSITY_KEY, nextDensity);
      },
      effectsMode,
      setEffectsMode: (nextEffectsMode) => {
        setEffectsModeState(nextEffectsMode);
        writeStorage(EFFECTS_MODE_KEY, nextEffectsMode);
      },
      navMode,
      setNavMode: (nextNavMode) => {
        setNavModeState(nextNavMode);
        writeStorage(NAV_MODE_KEY, nextNavMode);
      },
      showTechnicalDetails,
      setShowTechnicalDetails: (enabled) => {
        setShowTechnicalDetailsState(enabled);
        writeStorage(DETAILS_KEY, String(enabled));
      },
      detailPanelPinned,
      setDetailPanelPinned: (enabled) => {
        setDetailPanelPinnedState(enabled);
        writeStorage(DETAIL_PANEL_PINNED_KEY, String(enabled));
      },
      statusCenterExpanded,
      setStatusCenterExpanded: (enabled) => {
        setStatusCenterExpandedState(enabled);
        writeStorage(STATUS_CENTER_EXPANDED_KEY, String(enabled));
      },
      activeCitadelId,
      setActiveCitadelId,
      activeWorkspaceId,
      setActiveWorkspaceId,
      setActiveScope,
      theme,
      themePreference,
      setTheme: (nextTheme) => {
        setThemeState(nextTheme);
        writeStorage(THEME_KEY, nextTheme);
      },
      notifications,
      setNotificationToastsEnabled: (enabled) => {
        setNotificationsState((current) => ({ ...current, toastsEnabled: enabled }));
        writeStorage(NOTIFICATION_TOASTS_KEY, String(enabled));
      },
      setNotificationSoundMode: (nextSoundMode) => {
        setNotificationsState((current) => ({ ...current, soundMode: nextSoundMode }));
        writeStorage(NOTIFICATION_SOUND_MODE_KEY, nextSoundMode);
      },
      setNotificationDesktopEnabled: (enabled) => {
        setNotificationsState((current) => ({ ...current, desktopEnabled: enabled }));
        writeStorage(NOTIFICATION_DESKTOP_KEY, String(enabled));
      },
      setNotificationOnlyWhenUnfocused: (enabled) => {
        setNotificationsState((current) => ({ ...current, onlyWhenUnfocused: enabled }));
        writeStorage(NOTIFICATION_ONLY_UNFOCUSED_KEY, String(enabled));
      },
    }),
    [
      scopeGeneration,
      mode,
      density,
      effectsMode,
      navMode,
      showTechnicalDetails,
      detailPanelPinned,
      statusCenterExpanded,
      activeCitadelId,
      activeWorkspaceId,
      setActiveCitadelId,
      setActiveWorkspaceId,
      setActiveScope,
      theme,
      themePreference,
      notifications,
    ],
  );

  return <UiPreferencesContext.Provider value={value}>{props.children}</UiPreferencesContext.Provider>;
}

export function useUiPreferences(): UiPreferencesValue {
  return useContext(UiPreferencesContext);
}

function readModeFromStorage(): UiExperienceMode {
  if (typeof window === "undefined") {
    return "simple";
  }
  const raw = readStorage(MODE_KEY);
  return raw === "advanced" ? "advanced" : "simple";
}

function readDetailsFromStorage(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const raw = readStorage(DETAILS_KEY);
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  const mode = readModeFromStorage();
  return mode === "advanced";
}

function readDensityFromStorage(): UiDensity {
  if (typeof window === "undefined") {
    return "default";
  }
  const raw = readStorage(DENSITY_KEY);
  if (raw === "comfortable" || raw === "compact") {
    return raw;
  }
  return "default";
}

function readEffectsModeFromStorage(): UiEffectsMode {
  if (typeof window === "undefined") {
    return "auto";
  }
  const raw = readStorage(EFFECTS_MODE_KEY);
  if (raw === "full" || raw === "reduced") {
    return raw;
  }
  return "auto";
}

function readNavModeFromStorage(): ShellNavMode {
  if (typeof window === "undefined") {
    return "compact";
  }
  const raw = readStorage(NAV_MODE_KEY);
  if (raw === "expanded" || raw === "compact" || raw === "icon") {
    return raw;
  }
  return "compact";
}

function readDetailPanelPinnedFromStorage(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return readStorage(DETAIL_PANEL_PINNED_KEY) === "true";
}

function readStatusCenterExpandedFromStorage(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return readStorage(STATUS_CENTER_EXPANDED_KEY) === "true";
}

function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Fallback: localStorage may be disabled or quota-exceeded; drop the write rather than crash.
  }
}

function readStorage(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Fallback: localStorage access may be denied (private mode); treat as absent rather than crash.
    return null;
  }
}

function readWorkspaceIdFromStorage(): string {
  if (typeof window === "undefined") {
    return "default";
  }
  return normalizeWorkspaceId(readStorage(WORKSPACE_KEY));
}

function readCitadelIdFromStorage(): string {
  if (typeof window === "undefined") {
    return "personal";
  }
  return normalizeCitadelId(readStorage(CITADEL_KEY));
}

function normalizeCitadelId(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "personal";
  }
  return /^[a-zA-Z0-9._-]{1,80}$/.test(trimmed) ? trimmed : "personal";
}

function normalizeWorkspaceId(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "default";
  }
  return /^[a-zA-Z0-9._-]{1,80}$/.test(trimmed) ? trimmed : "default";
}

function readThemeFromStorage(): UiTheme {
  if (typeof window === "undefined") {
    return "system";
  }
  const raw = readStorage(THEME_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** Reads the host color scheme; dark when the host cannot say (no window or no `matchMedia`). */
export function readSystemColorScheme(): UiResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

/** Tracks `prefers-color-scheme` live while `active`, so Match system follows a host change without a reload. */
function useSystemColorScheme(active: boolean): UiResolvedTheme {
  const [scheme, setScheme] = useState<UiResolvedTheme>(() => readSystemColorScheme());
  useEffect(() => {
    if (!active || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const query = window.matchMedia(DARK_SCHEME_QUERY);
    const sync = () => setScheme(query.matches ? "dark" : "light");
    sync();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", sync);
      return () => query.removeEventListener("change", sync);
    }
    query.addListener(sync);
    return () => query.removeListener(sync);
  }, [active]);
  return scheme;
}

function readNotificationPreferencesFromStorage(): UiNotificationPreferences {
  if (typeof window === "undefined") {
    return {
      toastsEnabled: true,
      soundMode: "off",
      desktopEnabled: false,
      onlyWhenUnfocused: false,
    };
  }
  return {
    toastsEnabled: readBooleanFromStorage(NOTIFICATION_TOASTS_KEY, true),
    soundMode: readNotificationSoundModeFromStorage(),
    desktopEnabled: readBooleanFromStorage(NOTIFICATION_DESKTOP_KEY, false),
    onlyWhenUnfocused: readBooleanFromStorage(NOTIFICATION_ONLY_UNFOCUSED_KEY, false),
  };
}

function readNotificationSoundModeFromStorage(): OperatorAttentionSoundMode {
  const raw = readStorage(NOTIFICATION_SOUND_MODE_KEY);
  if (raw === "subtle" || raw === "normal") {
    return raw;
  }
  return "off";
}

function readBooleanFromStorage(key: string, defaultValue: boolean): boolean {
  const raw = readStorage(key);
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return defaultValue;
}
