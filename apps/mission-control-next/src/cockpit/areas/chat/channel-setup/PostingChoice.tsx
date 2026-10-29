import { useId } from "react";

export interface PostingOption {
  value: string;
  /** What the operator reads: a name, never an id. */
  label: string;
}

/**
 * A choice of one from a short list, as a group of radio buttons under a legend. The options keep the order they are
 * given in. Each radio is named by its own text, and the group by its legend, so a click on the text chooses it and a
 * screen reader hears the question first.
 */
export function PostingChoice({
  legend,
  options,
  value,
  onChange,
  disabled = false,
}: {
  legend: string;
  options: readonly PostingOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  // Radios share a name to form one group; two choices on a page must not share it.
  const name = useId();
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-fg-secondary">{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="flex items-start gap-2 text-md text-fg sm:text-sm">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            className="mt-1 shrink-0"
            onChange={() => onChange(option.value)}
          />
          <span className="min-w-0 wrap-anywhere">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
