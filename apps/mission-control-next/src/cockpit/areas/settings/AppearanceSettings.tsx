import { useEffect, useId, useState } from "react";
import { cockpitInputClass } from "../../ui/input-class";
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
  const confirm = (label: string, stored: boolean, failure: string) => {
    setSaved(stored ? `${label} saved.` : failure);
  };
  return { saved, confirm };
}

export function AppearanceSettings() {
  const prefs = useUiPreferences();
  const desktop = useDesktopNotifications();
  const testReasonId = useId();
  const canSendTest = desktop.desktopPermission === "granted";
  const savedConfirmation = useSavedConfirmation();
  const confirm = savedConfirmation.confirm;
  return (
    <>
      <section aria-label="Appearance and attention" className="mt-4 grid gap-4 sm:grid-cols-2">
        <p className="text-xs text-fg-muted sm:col-span-2" data-settings-save-model="automatic">
          These preferences apply right away. This browser tries to save each change automatically.
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
                  confirm(
                    "Settings presentation",
                    prefs.setMode(event.target.value as "simple" | "advanced"),
                    "Couldn't save all settings presentation changes in this browser.",
                  );
                }}
                className={`mt-1 ${cockpitInputClass}`}
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
                  confirm(
                    "Color theme",
                    prefs.setTheme(event.target.value as UiTheme),
                    "Couldn't save color theme in this browser.",
                  );
                }}
                className={`mt-1 ${cockpitInputClass}`}
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
                  confirm(
                    "Density",
                    prefs.setDensity(event.target.value as "comfortable" | "compact"),
                    "Couldn't save density in this browser.",
                  );
                }}
                className={`mt-1 ${cockpitInputClass}`}
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
                confirm(
                  "Technical details",
                  prefs.setShowTechnicalDetails(event.target.checked),
                  "Couldn't save technical details in this browser.",
                );
              }}
            />{" "}
            Show technical details
          </label>
        </div>
        <div className="space-y-3">
          <h3 className="text-md font-semibold text-fg">Attention</h3>
          <label className="flex items-center gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={prefs.notifications.toastsEnabled}
              onChange={(event) => {
                confirm(
                  "Attention notices",
                  prefs.setNotificationToastsEnabled(event.target.checked),
                  "Couldn't save attention notices in this browser.",
                );
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
                  confirm(
                    "Sound",
                    prefs.setNotificationSoundMode(event.target.value as "off" | "subtle" | "normal"),
                    "Couldn't save sound in this browser.",
                  );
                }}
                className={`mt-1 ${cockpitInputClass}`}
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
                confirm(
                  "System notifications",
                  prefs.setNotificationDesktopEnabled(event.target.checked),
                  "Couldn't save system notifications in this browser.",
                );
              }}
            />{" "}
            Use system notifications when allowed
          </label>
          <label className="flex items-center gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={prefs.notifications.onlyWhenUnfocused}
              onChange={(event) => {
                confirm(
                  "Unfocused-only notifications",
                  prefs.setNotificationOnlyWhenUnfocused(event.target.checked),
                  "Couldn't save unfocused-only notifications in this browser.",
                );
              }}
            />{" "}
            Only notify when Mission Control is unfocused
          </label>
          <p className="text-xs text-fg-muted" role="status">
            {describeDesktopPermission(desktop.desktopPermission)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={desktop.checkingPermission}
              onClick={() => void desktop.checkDesktopPermission()}
            >
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
      </section>
      <div className="mt-6 border-t border-line-subtle pt-4">
        <AttentionNotificationRouting workspaceId={prefs.activeWorkspaceId} />
      </div>
      <div className="mt-6 border-t border-line-subtle pt-4">
        <DesktopUpdateSettings />
      </div>
    </>
  );
}
