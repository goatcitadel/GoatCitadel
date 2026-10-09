import { Field } from "../../ui/Field";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { describeDesktopPermission, useDesktopNotifications } from "../../../features/native-routes/settings/use-desktop-notifications";
import { Button } from "../../ui/Button";
import { DesktopUpdateSettings } from "./DesktopUpdateSettings";

export function AppearanceSettings() {
  const prefs = useUiPreferences();
  const desktop = useDesktopNotifications();
  return <section aria-label="Appearance and attention" className="mt-4 grid gap-4 border-t border-line-subtle pt-4 sm:grid-cols-2">
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-fg">Appearance</h3>
      <Field label="Settings presentation" help="Guided starts with setup steps. Expert reveals additional configuration; it grants no runtime permissions.">{(field) => <select {...field} value={prefs.mode}
        onChange={(event) => prefs.setMode(event.target.value as "simple" | "advanced")}
        className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg">
        <option value="simple">Guided</option><option value="advanced">Expert</option>
      </select>}</Field>
      <Field label="Color theme">{(field) => <select {...field} value={prefs.theme} onChange={(event) => prefs.setTheme(event.target.value as "light" | "dark")}
          className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg">
          <option value="light">Bright sky</option><option value="dark">Lifted navy</option>
        </select>}</Field>
      <Field label="Density" help="Comfortable gives controls more space; Compact keeps information dense.">{(field) => <select {...field} value={prefs.density === "compact" ? "compact" : "comfortable"}
          onChange={(event) => prefs.setDensity(event.target.value as "comfortable" | "compact")}
          className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg">
          <option value="comfortable">Comfortable</option><option value="compact">Compact</option>
        </select>}</Field>
      <label className="flex items-center gap-2 text-sm text-fg-secondary"><input type="checkbox" checked={prefs.showTechnicalDetails}
        onChange={(event) => prefs.setShowTechnicalDetails(event.target.checked)} /> Show technical details</label>
    </div>
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-fg">Attention</h3>
      <label className="flex items-center gap-2 text-sm text-fg-secondary"><input type="checkbox" checked={prefs.notifications.toastsEnabled}
        onChange={(event) => prefs.setNotificationToastsEnabled(event.target.checked)} /> Show attention notices</label>
      <label className="block text-sm text-fg-secondary">Sound for decisions and problems
        <select value={prefs.notifications.soundMode}
          onChange={(event) => prefs.setNotificationSoundMode(event.target.value as "off" | "subtle" | "normal")}
          className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg">
          <option value="off">Off</option><option value="subtle">Subtle</option><option value="normal">Normal</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-fg-secondary"><input type="checkbox" checked={prefs.notifications.desktopEnabled}
        onChange={(event) => prefs.setNotificationDesktopEnabled(event.target.checked)} /> Use system notifications when allowed</label>
      <label className="flex items-center gap-2 text-sm text-fg-secondary"><input type="checkbox" checked={prefs.notifications.onlyWhenUnfocused}
        onChange={(event) => prefs.setNotificationOnlyWhenUnfocused(event.target.checked)} /> Only notify when Mission Control is unfocused</label>
      <p className="text-xs text-fg-muted" role="status">{describeDesktopPermission(desktop.desktopPermission)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={desktop.checkingPermission} onClick={() => void desktop.checkDesktopPermission()}>
          {desktop.desktopPermission === "default" ? "Allow notifications" : "Re-check permission"}
        </Button>
        <Button size="sm" disabled={desktop.desktopPermission !== "granted"} onClick={desktop.sendTestNotification}>Send test notification</Button>
      </div>
      {desktop.notificationFeedback ? <p className="text-xs text-fg-secondary" role="status">{desktop.notificationFeedback}</p> : null}
      <p className="text-xs text-fg-muted">These display and attention choices are saved in this browser.</p>
    </div>
    <DesktopUpdateSettings />
  </section>;
}
