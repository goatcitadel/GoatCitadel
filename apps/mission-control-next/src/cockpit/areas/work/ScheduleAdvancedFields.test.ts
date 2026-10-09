import { expect, it } from "vitest";
import { EMPTY_SCHEDULE_SETTINGS, scheduleSettingsInput } from "./ScheduleAdvancedFields";
it.each([...["checkId", "severityThreshold"].flatMap(key => [key === "checkId" ? ["mcp_posture"] : ["error"], { toString: key === "checkId" ? "mcp_posture" : "error" }, 1, false, null].map(value => ({ key, value })))])("rejects actual non-string watchdog $key values", ({ key, value }) => {
  const watchdog = { checkId: "mcp_posture", severityThreshold: "error", notifyHomeChannel: false, [key]: value };
  expect(() => scheduleSettingsInput({ ...EMPTY_SCHEDULE_SETTINGS, actionConfig: JSON.stringify({ watchdog }) }, "watchdog")).toThrow("Watchdog configuration");
});
it("rejects unsupported task action configuration before dispatch instead of creating uncertainty", () => {
  expect(() => scheduleSettingsInput({ ...EMPTY_SCHEDULE_SETTINGS, actionConfig: '{"destination":"local"}' }, "task")).toThrow("does not support action configuration");
});
it("accepts exact supported watchdog configuration and canonicalizes the end date", () => {
  const config = { watchdog: { checkId: "runtime_health", severityThreshold: "warning", notifyHomeChannel: false } };
  expect(scheduleSettingsInput({ ...EMPTY_SCHEDULE_SETTINGS, endAt: "2026-12-06T09:00:00-08:00", actionConfig: JSON.stringify(config) }, "watchdog")).toEqual({ endAt: "2026-12-06T17:00:00.000Z", actionConfig: config });
  expect(() => scheduleSettingsInput({ ...EMPTY_SCHEDULE_SETTINGS, actionConfig: '{"watchdog":{}}' }, "watchdog")).toThrow("Watchdog configuration");
});
