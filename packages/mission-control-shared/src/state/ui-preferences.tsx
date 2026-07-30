import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { UiEffectsMode } from "./effects-mode";
import type { OperatorAttentionSoundMode } from "./operator-attention";
import type { ShellNavMode } from "../components/ShellNavRail";

export type UiExperienceMode = "simple" | "advanced";
export type UiDensity = "comfortable" | "default" | "compact";
export type UiTheme = "dark" | "light";

export interface UiNotificationPreferences {
  toastsEnabled: boolean;
  soundMode: OperatorAttentionSoundMode;
  desktopEnabled: boolean;
  onlyWhenUnfocused: boolean;
}

interface UiPreferencesValue {
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
  theme: UiTheme;
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
  const [theme, setThemeState] = useState<UiTheme>(() => readThemeFromStorage());
  const [notifications, setNotificationsState] = useState<UiNotificationPreferences>(() =>
    readNotificationPreferencesFromStorage(),
  );
  const setActiveCitadelId = useCallback((citadelId: string) => {
    const normalized = normalizeCitadelId(citadelId);
    setActiveCitadelIdState(normalized);
    writeStorage(CITADEL_KEY, normalized);
  }, []);
  const setActiveWorkspaceId = useCallback((workspaceId: string) => {
    const normalized = normalizeWorkspaceId(workspaceId);
    setActiveWorkspaceIdState(normalized);
    writeStorage(WORKSPACE_KEY, normalized);
  }, []);
  const setActiveScope = useCallback((scope: { citadelId: string; workspaceId: string }) => {
    const normalizedCitadelId = normalizeCitadelId(scope.citadelId);
    const normalizedWorkspaceId = normalizeWorkspaceId(scope.workspaceId);
    setActiveCitadelIdState(normalizedCitadelId);
    setActiveWorkspaceIdState(normalizedWorkspaceId);
    writeStorage(CITADEL_KEY, normalizedCitadelId);
    writeStorage(WORKSPACE_KEY, normalizedWorkspaceId);
  }, []);

  const value = useMemo<UiPreferencesValue>(
    () => ({
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
    return "dark";
  }
  const raw = readStorage(THEME_KEY);
  return raw === "light" ? "light" : "dark";
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
