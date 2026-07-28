import type { RunVariableField, RunVariableValue } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@goatcitadel/mission-control-shared/components/ui";

type PanelState = NonNullable<MissionThreadedActiveSessionSurfaceProps["runVariablePanel"]>;

export function RunVariablePanel({ panel }: { panel: PanelState }) {
  return (
    <Dialog open={panel.open} onOpenChange={(open) => !open && panel.onClose()}>
      <DialogContent className="mc-next-run-variables" aria-describedby="run-variable-description">
        <DialogHeader>
          <DialogTitle>{panel.title}</DialogTitle>
          <DialogDescription id="run-variable-description">
            Complete the declared inputs, review the resolved prompt, then place it in the Chat composer.
          </DialogDescription>
        </DialogHeader>

        <form
          className="mc-next-run-variables__body"
          onSubmit={(event) => {
            event.preventDefault();
            panel.onApply();
          }}
        >
          <div className="mc-next-run-variables__fields">
            {panel.schema.fields.map((field) => (
              <VariableField
                key={field.id}
                field={field}
                value={panel.values[field.id]}
                onChange={(value) => panel.onValueChange(field.id, value)}
              />
            ))}
          </div>

          <section className="mc-next-run-variables__preview" aria-live="polite" aria-label="Resolved prompt preview">
            <h3>Resolved prompt preview</h3>
            {panel.preview ? <pre>{panel.preview}</pre> : <p>Complete the required fields to generate a preview.</p>}
          </section>

          {panel.error ? (
            <p role="alert" className="mc-next-run-variables__error">
              {panel.error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={panel.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={Boolean(panel.error) || !panel.preview}>
              Use in Chat
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VariableField({
  field,
  value,
  onChange,
}: {
  field: RunVariableField;
  value: RunVariableValue | undefined;
  onChange: (value: RunVariableValue | undefined) => void;
}) {
  const label = (
    <span>
      {field.label}
      {field.required ? <em aria-label="required"> *</em> : null}
    </span>
  );
  const descriptionId = field.description ? `run-variable-${field.id}-description` : undefined;

  if (field.type === "boolean") {
    return (
      <label className="mc-next-run-variables__check">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.currentTarget.checked)} />
        <span>
          {label}
          {field.description ? <small id={descriptionId}>{field.description}</small> : null}
        </span>
      </label>
    );
  }

  return (
    <label>
      {label}
      {field.description ? <small id={descriptionId}>{field.description}</small> : null}
      {field.type === "multiline" ? (
        <Textarea
          value={typeof value === "string" ? value : ""}
          required={field.required}
          minLength={field.minLength}
          maxLength={field.maxLength}
          aria-describedby={descriptionId}
          onChange={(event) => onChange(event.currentTarget.value || undefined)}
        />
      ) : field.type === "select" ? (
        <select
          value={typeof value === "string" ? value : ""}
          required={field.required}
          aria-describedby={descriptionId}
          onChange={(event) => onChange(event.currentTarget.value || undefined)}
        >
          <option value="">Select…</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={resolveInputType(field.type)}
          value={typeof value === "string" || typeof value === "number" ? value : ""}
          required={field.required}
          min={field.type === "number" ? field.minimum : undefined}
          max={field.type === "number" ? field.maximum : undefined}
          minLength={field.type === "number" ? undefined : field.minLength}
          maxLength={field.type === "number" ? undefined : field.maxLength}
          placeholder={field.type === "datetime" ? "2026-07-28T09:30:00-07:00" : undefined}
          aria-describedby={descriptionId}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            onChange(field.type === "number" ? (raw === "" ? undefined : Number(raw)) : raw || undefined);
          }}
        />
      )}
    </label>
  );
}

function resolveInputType(type: RunVariableField["type"]): "text" | "number" | "url" | "date" {
  if (type === "number" || type === "url" || type === "date") return type;
  return "text";
}
