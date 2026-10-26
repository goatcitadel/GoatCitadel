import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../lib/cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** The accessible name, for example the connector's name. The visible On/Off word is not part of it. */
  label: string;
  /** Visible state word while on. Defaults to "On". */
  onText?: string;
  /** Visible state word while off. Defaults to "Off". */
  offText?: string;
  disabled?: boolean;
  /**
   * A change is saving: sets aria-busy and aria-disabled, dims the switch and ignores toggles. It stays focusable and is
   * not natively disabled, so a keyboard operator keeps their place. Use `disabled` for a switch that can't be used.
   */
  pending?: boolean;
  /** Id of the element that describes this switch. */
  describedBy?: string;
}

/**
 * The cockpit's on/off control: a pill track filled with the accent when on, a thumb that slides across, and a visible
 * state word before it. The word is a hint for sighted operators and stays `aria-hidden` outside the button, so the
 * switch is named by `label` alone and reports its state through `aria-checked`.
 *
 * The Radix button is the hit area (the global coarse-pointer rule grows it to 44px) and the track is drawn inside it,
 * so a phone gets a large target without a stretched track. Focus uses the cockpit's global focus ring, as `Button` does.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  onText = "On",
  offText = "Off",
  disabled = false,
  pending = false,
  describedBy,
}: SwitchProps) {
  const unavailable = disabled || pending;
  // A switch that is saving ignores toggles instead of going native-disabled, so focus stays where the operator left it.
  const handleCheckedChange = (next: boolean) => {
    if (pending) return;
    onCheckedChange(next);
  };
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "min-w-6 text-right text-sm font-medium",
          checked ? "text-fg" : "text-fg-secondary",
          unavailable && "opacity-50",
        )}
      >
        {checked ? onText : offText}
      </span>
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={handleCheckedChange}
        // Only `disabled` is native. A saving switch stays focusable (a disabled button drops keyboard focus to <body>).
        disabled={disabled}
        aria-label={label}
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        aria-describedby={describedBy}
        className="group/switch inline-flex shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed aria-busy:cursor-progress"
      >
        <span
          className={cn(
            "inline-flex h-5 w-9 shrink-0 items-center rounded-full border p-px transition-colors",
            checked ? "border-transparent bg-accent" : "border-line-control bg-raised",
            !unavailable && (checked ? "group-hover/switch:bg-accent-hover" : "group-hover/switch:border-fg"),
            unavailable && "opacity-50",
          )}
        >
          <SwitchPrimitive.Thumb
            className={cn(
              "pointer-events-none block size-4 rounded-full transition-transform",
              checked ? "translate-x-4 bg-accent-ink" : "bg-fg-muted",
            )}
          />
        </span>
      </SwitchPrimitive.Root>
    </span>
  );
}
