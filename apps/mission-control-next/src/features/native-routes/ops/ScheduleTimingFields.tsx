import { useRef } from "react";

/** Guided presets are projections of the existing cron string, not a new schedule contract. */
export function ScheduleTimingFields({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const advanced = useRef<HTMLDetailsElement>(null);
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(value);
  const timed = match && Number(match[1]) < 60 && Number(match[2]) < 24 ? match : null;
  const cadence = timed ? (timed[3] === "1-5" ? "weekdays" : "daily") : value === "0 * * * *" ? "hourly" : "custom";
  return (
    <>
      <label className="mc-next-settings-field">
        <span>Frequency</span>
        <select
          className="mc-next-settings-input"
          aria-label="Schedule frequency"
          value={cadence}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "custom") {
              if (advanced.current) {
                advanced.current.open = true;
                advanced.current.querySelector("input")?.focus();
              }
            } else {
              onChange(next === "hourly" ? "0 * * * *" : next === "weekdays" ? "0 9 * * 1-5" : "0 9 * * *");
            }
          }}
        >
          <option value="daily">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="hourly">Every hour</option>
          <option value="custom">Custom cron</option>
        </select>
      </label>
      {timed ? (
        <label className="mc-next-settings-field">
          <span>Time</span>
          <input
            className="mc-next-settings-input"
            type="time"
            aria-label="Schedule time"
            value={timed[2]!.padStart(2, "0") + ":" + timed[1]!.padStart(2, "0")}
            onChange={(event) => {
              const [hour, minute] = event.target.value.split(":");
              if (hour && minute) onChange(Number(minute) + " " + Number(hour) + " * * " + timed[3]);
            }}
          />
        </label>
      ) : null}
      <details ref={advanced} className="mc-next-approvals-details span-2">
        <summary>Advanced cron schedule</summary>
        <label className="mc-next-settings-field">
          <span>Schedule</span>
          <input
            className="mc-next-settings-input"
            aria-label="Cron expression"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="0 9 * * *"
          />
        </label>
      </details>
    </>
  );
}
