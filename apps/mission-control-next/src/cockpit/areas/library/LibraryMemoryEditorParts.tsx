import { useState } from "react";
import type { MemoryChangeEvent } from "@goatcitadel/contracts";
import { formatSeconds } from "@goatcitadel/mission-control-shared/content/format";
import { Field } from "../../ui/Field";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { MEMORY_CHANGE } from "./library-vocabulary";

export const MEMORY_TTL_MAX_SECONDS = 31_536_000;
const TTL_PRESETS: readonly { seconds: number; label: string }[] = [
  { seconds: 3_600, label: "1 hour" },
  { seconds: 86_400, label: "1 day" },
  { seconds: 604_800, label: "7 days" },
  { seconds: 2_592_000, label: "30 days" },
];
const TTL_UNITS = { minutes: 60, hours: 3_600, days: 86_400 } as const;
type TtlUnit = keyof typeof TTL_UNITS;

function customParts(seconds: string): { amount: string; unit: TtlUnit } {
  const value = Number(seconds);
  if (!seconds || !Number.isFinite(value) || value <= 0) return { amount: "", unit: "hours" };
  const unit: TtlUnit = value % 86_400 === 0 ? "days" : value % 3_600 === 0 ? "hours" : "minutes";
  return { amount: String(value / TTL_UNITS[unit]), unit };
}

/**
 * Memory expiry as a duration: the default, a preset, or a custom amount and unit. The value stays the
 * whole number of seconds the Gateway expects ("" for the default).
 */
export function MemoryTtlField({ value, onChange }: { value: string; onChange: (seconds: string) => void }) {
  const preset = TTL_PRESETS.some((option) => String(option.seconds) === value);
  const [custom, setCustom] = useState(() => (value && !preset ? customParts(value) : undefined));
  const mode = custom ? "custom" : value || "";
  const seconds = Number(value);
  function setCustomParts(next: { amount: string; unit: TtlUnit }) {
    setCustom(next);
    const amount = Number(next.amount);
    onChange(next.amount.trim() && Number.isFinite(amount) ? String(Math.round(amount * TTL_UNITS[next.unit])) : "");
  }
  const invalid =
    value !== "" && (!Number.isInteger(seconds) || seconds < 1 || seconds > MEMORY_TTL_MAX_SECONDS)
      ? "Choose an expiry between 1 minute and 365 days."
      : undefined;
  return (
    <div className="grid gap-2">
      <Field
        label="Memory expiry"
        help={value && !invalid ? `Expires ${formatSeconds(seconds)} after it is saved.` : undefined}
        error={invalid}
      >
        {(props) => (
          <select
            {...props}
            className="w-full rounded-md border border-line bg-raised p-2"
            value={mode}
            onChange={(event) => {
              if (event.target.value === "custom") return setCustomParts(customParts(value));
              setCustom(undefined);
              onChange(event.target.value);
            }}
          >
            <option value="">Use the default expiry</option>
            {TTL_PRESETS.map((option) => (
              <option key={option.seconds} value={String(option.seconds)}>
                {option.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        )}
      </Field>
      {custom ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Custom expiry amount">
            {(props) => (
              <input
                {...props}
                type="number"
                min={1}
                className="w-28 rounded-md border border-line bg-raised p-2"
                value={custom.amount}
                onChange={(event) => setCustomParts({ ...custom, amount: event.target.value })}
              />
            )}
          </Field>
          <Field label="Custom expiry unit">
            {(props) => (
              <select
                {...props}
                className="rounded-md border border-line bg-raised p-2"
                value={custom.unit}
                onChange={(event) => setCustomParts({ ...custom, unit: event.target.value as TtlUnit })}
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            )}
          </Field>
        </div>
      ) : null}
    </div>
  );
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  title: "title",
  content: "content",
  pinned: "pin",
  ttlOverrideSeconds: "expiry",
  metadata: "details",
  status: "status",
};

/** "Changed: title and content" from a history event's field codes; history never stores the old text. */
export function memoryChangeSummary(event: MemoryChangeEvent): string | undefined {
  const codes = event.payload.fieldCodes;
  if (!Array.isArray(codes)) return undefined;
  const fields = codes.flatMap((code) => (typeof code === "string" ? [FIELD_LABELS[code] ?? "other details"] : []));
  if (!fields.length) return undefined;
  const unique = [...new Set(fields)];
  const list = unique.length > 1 ? `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}` : unique[0];
  return `Changed: ${list}.`;
}

export function MemoryHistoryList({ events }: { events: MemoryChangeEvent[] }) {
  return (
    <>
      <p className="text-sm text-fg-muted">
        History records which fields changed and when. It does not keep earlier text, so it can't show a word-level
        difference.
      </p>
      <ul className="grid gap-2">
        {events.map((event) => (
          <li key={event.changeId} className="rounded-md border border-line p-2">
            <h3>{MEMORY_CHANGE[event.changeType]}</h3>
            {memoryChangeSummary(event) ? (
              <p className="text-sm text-fg-secondary">{memoryChangeSummary(event)}</p>
            ) : null}
            <p className="text-sm text-fg-secondary">
              <TimeText value={event.createdAt} />
              {typeof event.payload.approvalId === "string" ? " · Approved change" : null}
            </p>
            <TechnicalDetails label="Technical event details">
              <p>
                {event.createdAt} · Actor ID: {event.actorId ?? "none"}
              </p>
              <pre className="whitespace-pre-wrap break-words">{JSON.stringify(event.payload, null, 2)}</pre>
            </TechnicalDetails>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * What a response without an approval request means, by action. A forget of an already-forgotten item is a
 * no-op; an edit always needs approval, so a missing request is reported as unconfirmed, never as done.
 */
export function noApprovalNeededMessage(action: "save" | "forget"): string {
  return action === "forget"
    ? "This item was already forgotten. Nothing changed."
    : "No approval request came back for these changes, so nothing is waiting for approval. Refresh the item and check Inbox before trying again. Your draft is kept.";
}
