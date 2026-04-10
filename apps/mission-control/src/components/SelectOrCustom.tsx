import { useEffect, useMemo, useState } from "react";
import { globalCopy } from "../content/copy";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectOrCustomProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  customLabel?: string;
  customPlaceholder?: string;
  customOptionLabel?: string;
  inputType?: "text" | "password";
  disabled?: boolean;
  allowCustom?: boolean;
  autoSelectFirstOption?: boolean;
  onCustomModeChange?: (customMode: boolean) => void;
  suggestedModeLabel?: string;
  customModeLabel?: string;
  forceCustomMode?: boolean;
}

export function SelectOrCustom(props: SelectOrCustomProps) {
  const dedupedOptions = useMemo(() => dedupeOptions(props.options), [props.options]);
  const isKnownValue = dedupedOptions.some((option) => option.value === props.value);
  const allowCustom = props.allowCustom ?? true;
  const autoSelectFirstOption = props.autoSelectFirstOption ?? false;
  const [isCustomMode, setIsCustomMode] = useState<boolean>(Boolean(props.forceCustomMode));
  const hasUnknownValue = Boolean(props.value) && !isKnownValue;

  const selectValue = isKnownValue
    ? props.value
    : autoSelectFirstOption
      ? dedupedOptions[0]?.value ?? ""
      : "";

  useEffect(() => {
    if (!autoSelectFirstOption) {
      return;
    }
    if (isCustomMode) {
      return;
    }
    if (isKnownValue) {
      return;
    }
    const fallback = dedupedOptions[0]?.value;
    if (!fallback) {
      return;
    }
    props.onChange(fallback);
  }, [autoSelectFirstOption, dedupedOptions, isCustomMode, isKnownValue, props.onChange]);

  return (
    <div className="select-or-custom">
      {allowCustom ? (
        <div className="mode-switch" role="tablist" aria-label="Input mode">
          <button
            type="button"
            className={["gc-button", (!isCustomMode ? "active" : "")].filter(Boolean).join(" ")}
            disabled={props.disabled}
            onClick={() => {
              setIsCustomMode(false);
              props.onCustomModeChange?.(false);
              if (!isKnownValue && autoSelectFirstOption && dedupedOptions[0]) {
                props.onChange(dedupedOptions[0].value);
              }
            }}
          >
            {props.suggestedModeLabel ?? globalCopy.selectOrCustom.suggested}
          </button>
          <button
            type="button"
            className={["gc-button", (isCustomMode ? "active" : "")].filter(Boolean).join(" ")}
            disabled={props.disabled}
            onClick={() => {
              setIsCustomMode(true);
              props.onCustomModeChange?.(true);
            }}
          >
            {props.customModeLabel ?? globalCopy.selectOrCustom.custom}
          </button>
        </div>
      ) : null}
      <select
        id={props.id}
        value={isCustomMode ? (isKnownValue ? props.value : dedupedOptions[0]?.value ?? "") : selectValue}
        disabled={props.disabled}
        onChange={(event) => {
          setIsCustomMode(false);
          props.onCustomModeChange?.(false);
          props.onChange(event.target.value);
        }}
      >
        {!isKnownValue ? (
          <option value="">{props.customPlaceholder ?? globalCopy.selectOrCustom.selectValue}</option>
        ) : null}
        {dedupedOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {hasUnknownValue && !isCustomMode && allowCustom ? (
        <p className="office-subtitle">
          {globalCopy.selectOrCustom.customValueHint}
        </p>
      ) : null}

      {isCustomMode ? (
        <div className="controls-row select-custom-input">
          {props.customLabel ? <label>{props.customLabel}</label> : null}
          <input
            type={props.inputType ?? "text"}
            value={props.value}
            placeholder={props.customPlaceholder ?? globalCopy.selectOrCustom.enterCustom}
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}

function dedupeOptions(options: SelectOption[]): SelectOption[] {
  const seen = new Set<string>();
  const deduped: SelectOption[] = [];

  for (const option of options) {
    if (!option.value.trim()) {
      continue;
    }
    if (seen.has(option.value)) {
      continue;
    }
    seen.add(option.value);
    deduped.push(option);
  }

  return deduped;
}
