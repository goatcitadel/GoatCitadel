import { useId, type ReactNode } from "react";

export function Field({ label, help, error, children }: {
  label: string; help?: string; error?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}) {
  const id = useId();
  const description = [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return <div className="space-y-1 text-sm text-fg-secondary">
    <label htmlFor={id} className="block font-medium">{label}</label>
    {children({ id, "aria-describedby": description, "aria-invalid": error ? true : undefined })}
    {help ? <p id={`${id}-help`}>{help}</p> : null}
    {error ? <p id={`${id}-error`} role="alert">{error}</p> : null}
  </div>;
}
