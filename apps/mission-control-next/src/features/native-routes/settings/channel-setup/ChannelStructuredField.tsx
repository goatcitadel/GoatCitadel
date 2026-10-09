import type { ChannelSetupFieldDefinition } from "@goatcitadel/contracts";
import { readChannelTargetRows, type ChannelTargetRow } from "./channel-wizard-model";

export function ChannelStructuredField({
  field, value, id, describedBy, invalid, disabled, inputClassName, onChange,
}: {
  field: ChannelSetupFieldDefinition; value: unknown; id: string; describedBy: string; invalid?: boolean;
  disabled: boolean; inputClassName: string; onChange: (value: unknown) => void;
}) {
  const actionClass = "min-h-10 rounded-md border border-line px-3 py-2 text-sm";
  if (field.type === "sender-list") {
    const entries = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") :
      typeof value === "string" ? value.split(/[\n,]+/u).map((item) => item.trim()).filter(Boolean) : [];
    return <div>
      <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} required={field.required} className={inputClassName} disabled={disabled}
        rows={3} value={entries.join("\n")} placeholder={field.placeholder ?? "One sender ID per line"}
        onChange={(event) => onChange(event.target.value.split(/[\n,]+/u).map((item) => item.trim()).filter(Boolean))} />
      <p className="mt-1 text-xs text-fg-muted">{entries.length} explicit sender{entries.length === 1 ? "" : "s"} configured.</p>
    </div>;
  }
  const addressKey = field.targetAddressKey ?? "chatId";
  const threadKey = addressKey === "channel" ? "threadTs" : "threadId";
  const rows = readChannelTargetRows(value, addressKey);
  const update = (index: number, patch: Partial<ChannelTargetRow>) =>
    onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const legacyInvalid = typeof value === "string" && value.trim() && rows.length === 0;
  return <fieldset id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} className="min-w-0 space-y-3" disabled={disabled}>
    <legend className="sr-only">{field.label}</legend>
    {legacyInvalid ? <p role="alert">This saved target value needs repair. Review it in Advanced JSON before replacing it.</p> : null}
    {!rows.length ? <p className="text-sm text-fg-muted">No destinations selected. Add a destination or choose a discovered chat.</p> : null}
    {rows.map((row, index) => <section key={row.id + ":" + index} aria-label={"Destination " + (index + 1)}
      className="min-w-0 space-y-2 rounded-md border border-line p-3">
      <label className="block text-sm" htmlFor={id + "-label-" + index}>Destination name
        <input id={id + "-label-" + index} className={inputClassName} value={row.label}
          onChange={(event) => update(index, { label: event.target.value })} placeholder="Home, operations, or research" />
      </label>
      <label className="block text-sm" htmlFor={id + "-address-" + index}>
        {addressKey === "channel" ? "Slack channel name or ID" : "Telegram chat ID or @channel"}
        <input id={id + "-address-" + index} className={inputClassName} value={String(row[addressKey] ?? "")}
          inputMode="text" aria-required={true} aria-invalid={!String(row[addressKey] ?? "").trim() || undefined}
          onChange={(event) => update(index, { [addressKey]: event.target.value })}
          placeholder={addressKey === "channel" ? "#ops or C0123456789" : "-1001234567890 or @ops_channel"} />
      </label>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input type="radio" name={id + "-default"} required={field.required} checked={row.default === true}
          onChange={() => onChange(rows.map((item, itemIndex) => ({ ...item, default: itemIndex === index })))} />
        Default destination
      </label>
      <details className="text-sm">
        <summary className="cursor-pointer">Optional thread</summary>
        <label htmlFor={id + "-thread-" + index}>
          {addressKey === "channel" ? "Thread timestamp" : "Forum topic ID"}
          <input id={id + "-thread-" + index} className={inputClassName} value={String(row[threadKey] ?? "")}
            inputMode="text" onChange={(event) => update(index, { [threadKey]: event.target.value })} />
        </label>
      </details>
      <button type="button" className={actionClass} onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}
        aria-label={"Remove destination " + (row.label || String(row[addressKey] ?? index + 1))}>Remove destination</button>
    </section>)}
    <button type="button" disabled={disabled} className={actionClass} onClick={() => {
      let next = rows.length + 1;
      while (rows.some((row) => row.id === "target-" + next)) next += 1;
      onChange([...rows, { id: "target-" + next, label: "", [addressKey]: "", default: rows.length === 0 }]);
    }}>Add destination</button>
    {rows.length && rows.filter((row) => row.default).length !== 1 ?
      <p role="status" className="text-sm text-status-waiting">Choose exactly one default destination before continuing.</p> : null}
  </fieldset>;
}
