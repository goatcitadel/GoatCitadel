import { useEffect, useId, useState } from "react";
import { Field } from "../../ui/Field";
import { useUiPreferences, type UiTheme } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import {
  describeDesktopPermission,
  useDesktopNotifications,
} from "../../../features/native-routes/settings/use-desktop-notifications";
import { Button } from "../../ui/Button";
import { DesktopUpdateSettings } from "./DesktopUpdateSettings";
import { AttentionNotificationRouting } from "./AttentionNotificationRouting";
import { THEME_OPTIONS } from "../../app/theme-options";

/** How long the inline "saved" confirmation stays after an instant-apply change. */
const SAVED_CONFIRMATION_MS = 4000;

/**
 * ST-16: this page applies each change immediately (no drafts or Save button), so it says so up front and
 * confirms the last change inline. The confirmation is plain text, not a live region; the changed control
 * already announces its own new value.
 */
function useSavedConfirmation() {
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!saved) return undefined;
    const timer = window.setTimeout(() => setSaved(null), SAVED_CONFIRMATION_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);
  return { saved, confirm: (label: string) => setSaved(`${label} saved.`) };
}

export function AppearanceSettings() {
  const prefs = useUiPreferences();
  const desktop = useDesktopNotifications();
  const testReasonId = useId();
  const canSendTest = desktop.desktopPermission === "granted";
  const savedConfirmation = useSavedConfirmation();
  const confirm = savedConfirmation.confirm;
  return (
    <section
      aria-label="Appearance and attention"
      className="mt-4 grid gap-4 border-t border-line-subtle pt-4 sm:grid-cols-2"
    >
      <p className="text-xs text-fg-muted sm:col-span-2" data-settings-save-model="automatic">
        <span className="font-semibold text-fg-secondary">Saved automatically</span> · Changes on this page apply right
        away and are saved in this browser.
        {savedConfirmation.saved ? <span className="text-fg-secondary"> {savedConfirmation.saved}</span> : null}
      </p>
      <div className="space-y-3">
        <Field
          label="Settings presentation"
          help="Guided starts with setup steps. Expert reveals additional configuration; it grants no runtime permissions."
        >
          {(fieldProps) => (
            <select
              {...fieldProps}
              value={prefs.mode}
              onChange={(event) => {
                prefs.setMode(event.target.value as "simple" | "advanced");
                confirm("Settings presentation");
              }}
              className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg"
            >
              <option value="simple">Guided</option>
              <option value="advanced">Expert</option>
            </select>
          )}
        </Field>
        <Field label="Color theme" help="Match system follows your device’s light or dark setting as it changes.">
          {(fieldProps) => (
            <select
              {...fieldProps}
              value={prefs.themePreference}
              onChange={(event) => {
                prefs.setTheme(event.target.value as UiTheme);
                confirm("Color theme");
              }}
              className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg"
            >
              {THEME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Density" help="Comfortable gives controls more space; Compact keeps information dense.">
          {(fieldProps) => (
            <select
              {...fieldProps}
              value={prefs.density === "compact" ? "compact" : "comfortable"}
              onChange={(event) => {
                prefs.setDensity(event.target.value as "comfortable" | "compact");
                confirm("Density");
              }}
              className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg"
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm text-fg-secondary">
          <input
            type="checkbox"
            checked={prefs.showTechnicalDetails}
            onChange={(event) => {
              prefs.setShowTechnicalDetails(event.target.checked);
              confirm("Technical details");
            }}
          />{" "}
          Show technical details
        </label>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-fg">Attention</h3>
        <label className="flex items-center gap-2 text-sm text-fg-secondary">
          <input
            type="checkbox"
            checked={prefs.notifications.toastsEnabled}
            onChange={(event) => {
              prefs.setNotificationToastsEnabled(event.target.checked);
              confirm("Attention notices");
            }}
          />{" "}
          Show attention notices
        </label>
        <Field label="Sound for decisions and problems">
          {(fieldProps) => (
            <select
              {...fieldProps}
              value={prefs.notifications.soundMode}
              onChange={(event) => {
                prefs.setNotificationSoundMode(event.target.value as "off" | "subtle" | "normal");
                confirm("Sound");
              }}
              className="mt-1 block min-h-10 w-full rounded-md border border-line-control bg-canvas px-2 text-fg"
            >
              <option value="off">Off</option>
              <option value="subtle">Subtle</option>
              <option value="normal">Normal</option>
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm text-fg-secondary">
          <input
            type="checkbox"
            checked={prefs.notifications.desktopEnabled}
            onChange={(event) => {
              prefs.setNotificationDesktopEnabled(event.target.checked);
              confirm("System notifications");
            }}
          />{" "}
          Use system notifications when allowed
        </label>
        <label className="flex items-center gap-2 text-sm text-fg-secondary">
          <input
            type="checkbox"
            checked={prefs.notifications.onlyWhenUnfocused}
            onChange={(event) => {
              prefs.setNotificationOnlyWhenUnfocused(event.target.checked);
              confirm("Unfocused-only notifications");
            }}
          />{" "}
          Only notify when Mission Control is unfocused
        </label>
        <p className="text-xs text-fg-muted" role="status">
          {describeDesktopPermission(desktop.desktopPermission)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={desktop.checkingPermission} onClick={() => void desktop.checkDesktopPermission()}>
            {desktop.desktopPermission === "default" ? "Allow notifications" : "Re-check permission"}
          </Button>
          <Button
            size="sm"
            disabled={!canSendTest}
            aria-describedby={canSendTest ? undefined : testReasonId}
            onClick={desktop.sendTestNotification}
          >
            Send test notification
          </Button>
        </div>
        {canSendTest ? null : (
          <p id={testReasonId} className="text-xs text-fg-muted">
            {desktop.desktopPermission === "unsupported"
              ? "A test needs system notifications, which this browser or host does not support."
              : "A test is available after your browser or host allows system notifications."}
          </p>
        )}
        {desktop.notificationFeedback ? (
          <p className="text-xs text-fg-secondary" role="status">
            {desktop.notificationFeedback}
          </p>
        ) : null}
      </div>
      <AttentionNotificationRouting workspaceId={prefs.activeWorkspaceId} />
      <DesktopUpdateSettings />
    </section>
  );
}
