import { useRef, useState } from "react";
import { Field } from "../../ui/Field";
import { buildScheduleExpression, scheduleCadence, scheduleTiming, type ScheduleCadence } from "./schedule-cadence";

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
        <Field label="Time">
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
