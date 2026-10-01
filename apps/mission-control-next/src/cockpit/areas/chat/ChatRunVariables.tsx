import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { useId } from "react";
import { Button } from "../../ui/Button";

type Panel = NonNullable<MissionThreadedActiveSessionSurfaceProps["runVariablePanel"]>;

export function ChatRunVariables({ panel }: { panel: Panel | undefined }) {
  const formId = useId();
  if (!panel?.open) return null;
  return (
    <section
      aria-label="Run variables"
      className="mb-2 max-h-64 overflow-y-auto rounded-md border border-line bg-sunken p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-display text-sm font-semibold text-fg">{panel.title}</h2>
        <Button size="sm" onClick={panel.onClose}>
          Close
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {panel.schema.fields.map((field) => {
          const value = panel.values[field.id];
          const help = field.description ? `${formId}-${field.id}-help` : undefined;
          return (
            <label key={field.id} className="text-xs text-fg-secondary">
              {field.label}
              {field.required ? " *" : ""}
              {field.type === "boolean" ? (
                <input
                  aria-label={field.label}
                  aria-describedby={help}
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) => panel.onValueChange(field.id, event.target.checked)}
                  className="ml-2 align-middle"
                />
              ) : field.type === "select" ? (
                <select
                  aria-label={field.label}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => panel.onValueChange(field.id, event.target.value || undefined)}
                  aria-describedby={help}
                  className="mt-1 block min-h-9 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg"
                >
                  <option value="">Choose</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.type === "multiline" ? (
                <textarea
                  aria-label={field.label}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => panel.onValueChange(field.id, event.target.value || undefined)}
                  aria-describedby={help}
                  className="mt-1 block min-h-16 w-full rounded-md border border-line bg-canvas p-2 text-sm text-fg"
                />
              ) : (
                <input
                  aria-label={field.label}
                  type={
                    field.type === "number"
                      ? "number"
                      : field.type === "date"
                        ? "date"
                        : field.type === "url"
                          ? "url"
                          : "text"
                  }
                  value={value === undefined ? "" : String(value)}
                  min={field.type === "number" ? field.minimum : undefined}
                  max={field.type === "number" ? field.maximum : undefined}
                  onChange={(event) =>
                    panel.onValueChange(
                      field.id,
                      event.target.value === ""
                        ? undefined
                        : field.type === "number"
                          ? Number(event.target.value)
                          : event.target.value,
                    )
                  }
                  aria-describedby={help}
                  className="mt-1 block min-h-9 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg"
                />
              )}
              {field.description ? (
                <span id={help} className="mt-1 block text-fg-muted">
                  {field.description}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      {panel.error ? (
        <p role="alert" className="mt-2 text-xs text-status-failed">
          {panel.error}
        </p>
      ) : null}
      {panel.preview ? <p className="mt-2 whitespace-pre-wrap text-xs text-fg-muted">{panel.preview}</p> : null}
      <Button variant="primary" size="sm" className="mt-3" onClick={panel.onApply}>
        Apply variables
      </Button>
    </section>
  );
}
