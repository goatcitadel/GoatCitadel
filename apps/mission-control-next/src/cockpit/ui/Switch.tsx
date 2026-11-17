import { useLayoutEffect, useRef, type Ref } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../lib/cn";
import { useControlWave, warmControlWave } from "./use-control-wave";

const WAVE_SETTLE_MS = 200;

export interface SwitchProps {
  ref?: Ref<HTMLButtonElement>;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** The accessible name, for example the connector's name. The visible On/Off word is not part of it. */
  label: string;
  /** Visible state word while on. Defaults to "On". An empty word prints none, for a view that states it once elsewhere. */
  onText?: string;
  /** Visible state word while off. Defaults to "Off". An empty word prints none, as `onText`. */
  offText?: string;
  disabled?: boolean;
  /**
   * A change is saving: sets aria-busy and aria-disabled, dims the switch and ignores toggles. It stays focusable and is
   * not natively disabled, so a keyboard operator keeps their place. Use `disabled` for a switch that can't be used.
   */
  pending?: boolean;
  /** Id of the element that describes this switch. */
  describedBy?: string;
  /** Disable when the caller already owns the wave, as in the component gallery. */
  wave?: boolean;
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
  ref,
  checked,
  onCheckedChange,
  label,
  onText = "On",
  offText = "Off",
  disabled = false,
  pending = false,
  describedBy,
  wave = true,
}: SwitchProps) {
  const unavailable = disabled || pending;
  const track = useRef<HTMLSpanElement>(null);
  const { play: playWave, stop: stopWave } = useControlWave();
  const intent = useRef<{
    checked: boolean;
    source: HTMLButtonElement;
    focus: MouseEvent;
    label: string;
    expiresAt: number | undefined;
  }>(undefined);
  useLayoutEffect(() => {
    stopWave();
    const request = intent.current;
    if (!request) return;
    if (!wave || disabled || request.label !== label) {
      intent.current = undefined;
      return;
    }
    // A governed switch can stay pending across an approval. Play only when the
    // requested state has landed, so an animation cannot cover a stale track.
    if (pending) {
      request.expiresAt = undefined;
      return;
    }
    // A saved state and its pending flag can arrive in separate renders.
    const now = Date.now();
    request.expiresAt ??= now + WAVE_SETTLE_MS;
    if (now > request.expiresAt) {
      intent.current = undefined;
      return;
    }
    if (checked === request.checked && track.current) {
      intent.current = undefined;
      playWave(track.current, request.source, request.focus);
    }
  }, [checked, disabled, label, pending, playWave, stopWave, wave]);
  const warmWave = wave && !unavailable ? warmControlWave : undefined;
  const word = checked ? onText : offText;
  // A switch that is saving ignores toggles instead of going native-disabled, so focus stays where the operator left it.
  const handleCheckedChange = (next: boolean) => {
    if (pending) return;
    onCheckedChange(next);
  };
  return (
    <span className="inline-flex items-center gap-2">
      {word ? (
        <span
          aria-hidden="true"
          className={cn(
            "min-w-6 text-right text-sm font-medium",
            checked ? "text-fg" : "text-fg-secondary",
            unavailable && "opacity-50",
          )}
        >
          {word}
        </span>
      ) : null}
      <SwitchPrimitive.Root
        ref={ref}
        checked={checked}
        onCheckedChange={handleCheckedChange}
        onPointerEnter={warmWave}
        onFocus={warmWave}
        onClick={
          wave
            ? (event) => {
                if (!unavailable)
                  intent.current = {
                    checked: !checked,
                    source: event.currentTarget,
                    focus: event.nativeEvent,
                    label,
                    expiresAt: Date.now() + WAVE_SETTLE_MS,
                  };
              }
            : undefined
        }
        // Only `disabled` is native. A saving switch stays focusable (a disabled button drops keyboard focus to <body>).
        disabled={disabled}
        aria-label={label}
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        aria-describedby={describedBy}
        className="group/switch inline-flex shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed aria-busy:cursor-progress"
      >
        <span
          ref={track}
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
