import { useRef, useState } from "react";
import { Field } from "../../ui/Field";
import {
  browserTimeZone,
  buildScheduleExpression,
  formatInZone,
  GATEWAY_DEFAULT_SCHEDULE_ZONE,
  nextGuidedRun,
  scheduleCadence,
  scheduleTiming,
  scheduleZoneOptions,
  type ScheduleCadence,
} from "./schedule-cadence";

const INPUT = "w-full rounded-md border border-line bg-sunken p-2 text-fg";

/** Guided frequency and time over the saved schedule expression; the expression stays the only contract. */
export function ScheduleTiming({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const advanced = useRef<HTMLDetailsElement>(null);
  const timing = scheduleTiming(value);
  // Choosing Custom keeps that choice visible while the expression is edited, even if it still matches a preset.
  const [customChosen, setCustomChosen] = useState(false);
  const cadence = customChosen ? "custom" : timing.cadence;
  // WK-02: the typed time runs on the wall clock of the chosen zone; no suffix means the Gateway's UTC default.
  const zone = timing.zone ?? GATEWAY_DEFAULT_SCHEDULE_ZONE;
  const browser = browserTimeZone();
  const nextRun = nextGuidedRun(timing.cadence, timing.time, zone);
  const nextRunHelp = nextRun
    ? `Next run: ${formatInZone(nextRun, zone)} ${zone}` +
      (browser === zone ? "." : ` (${formatInZone(nextRun, browser)} your time, ${browser}).`)
    : undefined;
  return (
    <div className="grid min-w-0 gap-2">
      <Field label="Frequency">
        {(props) => (
          <select
            {...props}
            className={INPUT}
            value={cadence}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value as ScheduleCadence;
              if (next === "custom") {
                setCustomChosen(true);
                if (advanced.current) {
                  advanced.current.open = true;
                  advanced.current.querySelector("input")?.focus();
                }
                return;
              }
              setCustomChosen(false);
              onChange(buildScheduleExpression(next, timing.time, timing.zone));
            }}
          >
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="hourly">Every hour</option>
            <option value="custom">Custom expression</option>
          </select>
        )}
      </Field>
      {cadence === "daily" || cadence === "weekdays" ? (
        <Field label="Time" help={nextRunHelp}>
          {(props) => (
            <input
              {...props}
              type="time"
              className={INPUT}
              value={timing.time ?? ""}
              disabled={disabled}
              onChange={(event) => {
                if (event.target.value && (timing.cadence === "daily" || timing.cadence === "weekdays"))
                  onChange(buildScheduleExpression(timing.cadence, event.target.value, timing.zone));
              }}
            />
          )}
        </Field>
      ) : null}
      {cadence === "daily" || cadence === "weekdays" ? (
        <Field label="Timezone">
          {(props) => (
            <select
              {...props}
              className={INPUT}
              value={zone}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value;
                // Choosing UTC for an expression without a zone keeps it unchanged: UTC is already its zone.
                const suffix = next === GATEWAY_DEFAULT_SCHEDULE_ZONE && !timing.zone ? null : next;
                if (timing.cadence === "daily" || timing.cadence === "weekdays")
                  onChange(buildScheduleExpression(timing.cadence, timing.time, suffix));
              }}
            >
              {scheduleZoneOptions(zone, browser).map((option) => (
                <option key={option} value={option}>
                  {option === browser ? `${option} (your timezone)` : option}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      <p className="text-sm text-fg-secondary">{scheduleCadence(value)}</p>
      <details ref={advanced} className="text-sm">
        <summary className="min-h-11 cursor-pointer content-center font-medium text-fg">
          Advanced schedule expression
        </summary>
        <Field label="Schedule expression">
          {(props) => (
            <input
              {...props}
              className={`${INPUT} font-mono`}
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </Field>
      </details>
    </div>
  );
}
