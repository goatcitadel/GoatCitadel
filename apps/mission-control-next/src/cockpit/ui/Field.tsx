import { useId, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";

export function Field({
  label,
  help,
  error,
  required = false,
  children,
}: {
  label: string;
  help?: string;
  error?: string;
  /** Marks the label and passes aria-required to the control. */
  required?: boolean;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
    "aria-required"?: true;
  }) => ReactNode;
}) {
  const id = useId();
  // The error is read first: it is what the operator has to act on.
  const description = [error && `${id}-error`, help && `${id}-help`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1 text-sm text-fg-secondary [--cockpit-border:var(--cockpit-border-control)]">
      <label htmlFor={id} className="block font-medium">
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-status-failed">
            *
          </span>
        ) : null}
      </label>
      {children({
        id,
        "aria-describedby": description,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {error ? (
        <p id={`${id}-error`} role="alert" className="flex items-start gap-1.5 text-status-failed">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
      {help ? <p id={`${id}-help`}>{help}</p> : null}
    </div>
  );
}
