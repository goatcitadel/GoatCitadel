import { useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

interface GCSegmentedControlOption<TValue extends string> {
  value: TValue;
  label: string;
  disabled?: boolean;
}

interface GCSegmentedControlProps<TValue extends string> {
  value: TValue;
  options: GCSegmentedControlOption<TValue>[];
  onChange: (value: TValue) => void;
  ariaLabel: string;
  className?: string;
}

export function GCSegmentedControl<TValue extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: GCSegmentedControlProps<TValue>) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabledIndices = useMemo(() => options.flatMap((option, index) => (option.disabled ? [] : [index])), [options]);

  const moveSelection = (targetIndex: number) => {
    const option = options[targetIndex];
    if (!option || option.disabled) {
      return;
    }
    onChange(option.value);
    buttonRefs.current[targetIndex]?.focus();
  };

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, optionIndex: number) => {
    if (enabledIndices.length === 0) {
      return;
    }

    const currentEnabledIndex = enabledIndices.indexOf(optionIndex);
    if (currentEnabledIndex === -1) {
      return;
    }

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      const nextIndex = enabledIndices[(currentEnabledIndex + 1) % enabledIndices.length];
      if (typeof nextIndex !== "number") {
        return;
      }
      event.preventDefault();
      moveSelection(nextIndex);
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      const previousIndex = enabledIndices[(currentEnabledIndex - 1 + enabledIndices.length) % enabledIndices.length];
      if (typeof previousIndex !== "number") {
        return;
      }
      event.preventDefault();
      moveSelection(previousIndex);
      return;
    }

    if (event.key === "Home") {
      const firstIndex = enabledIndices[0];
      if (typeof firstIndex !== "number") {
        return;
      }
      event.preventDefault();
      moveSelection(firstIndex);
      return;
    }

    if (event.key === "End") {
      const lastIndex = enabledIndices[enabledIndices.length - 1];
      if (typeof lastIndex !== "number") {
        return;
      }
      event.preventDefault();
      moveSelection(lastIndex);
    }
  };

  return (
    <div
      className={cn("gc-segmented-control mc-gc-segmented-control", className)}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option, optionIndex) => (
        <Button
          key={option.value}
          type="button"
          ref={(element) => {
            buttonRefs.current[optionIndex] = element;
          }}
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          tabIndex={value === option.value ? 0 : -1}
          variant={value === option.value ? "default" : "ghost"}
          className={cn(
            "gc-button gc-segmented-control-option mc-gc-segmented-control-option",
            value === option.value && "active",
          )}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleOptionKeyDown(event, optionIndex)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
