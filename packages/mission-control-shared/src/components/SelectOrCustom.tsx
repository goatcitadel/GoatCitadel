import { useEffect, useMemo, useState } from "react";
import { globalCopy } from "../content/copy";
import { GCSelect } from "./ui";

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
  const {
    allowCustom: allowCustomProp,
    autoSelectFirstOption: autoSelectFirstOptionProp,
    customLabel,
    customModeLabel,
    customPlaceholder,
    disabled,
    forceCustomMode,
    id,
    inputType,
    onChange,
    onCustomModeChange,
    options,
    suggestedModeLabel,
    value,
  } = props;
  const dedupedOptions = useMemo(() => dedupeOptions(options), [options]);
  const isKnownValue = dedupedOptions.some((option) => option.value === value);
  const allowCustom = allowCustomProp ?? true;
  const autoSelectFirstOption = autoSelectFirstOptionProp ?? false;
  const [isCustomMode, setIsCustomMode] = useState<boolean>(Boolean(forceCustomMode));
  const hasUnknownValue = Boolean(value) && !isKnownValue;
  const selectOptions = useMemo(() => {
    const placeholderLabel = customPlaceholder ?? globalCopy.selectOrCustom.selectValue;

    if (isKnownValue || autoSelectFirstOption) {
      return dedupedOptions;
    }

    return [{ value: "", label: placeholderLabel, disabled: true }, ...dedupedOptions];
  }, [autoSelectFirstOption, customPlaceholder, dedupedOptions, isKnownValue]);

  const selectValue = isKnownValue ? value : autoSelectFirstOption ? (dedupedOptions[0]?.value ?? "") : "";

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
    onChange(fallback);
  }, [autoSelectFirstOption, dedupedOptions, isCustomMode, isKnownValue, onChange]);

  return (
    <div className="select-or-custom">
      {allowCustom ? (
        <div className="mode-switch" role="tablist" aria-label="Input mode">
          <button
            type="button"
            className={["gc-button", !isCustomMode ? "active" : ""].filter(Boolean).join(" ")}
            disabled={disabled}
            onClick={() => {
              setIsCustomMode(false);
              onCustomModeChange?.(false);
              if (!isKnownValue && autoSelectFirstOption && dedupedOptions[0]) {
                onChange(dedupedOptions[0].value);
              }
            }}
          >
            {suggestedModeLabel ?? globalCopy.selectOrCustom.suggested}
          </button>
          <button
            type="button"
            className={["gc-button", isCustomMode ? "active" : ""].filter(Boolean).join(" ")}
            disabled={disabled}
            onClick={() => {
              setIsCustomMode(true);
              onCustomModeChange?.(true);
            }}
          >
            {customModeLabel ?? globalCopy.selectOrCustom.custom}
          </button>
        </div>
      ) : null}
      <GCSelect
        id={id}
        value={isCustomMode ? (isKnownValue ? value : (dedupedOptions[0]?.value ?? "")) : selectValue}
        disabled={disabled}
        options={selectOptions}
        onChange={(nextValue) => {
          setIsCustomMode(false);
          onCustomModeChange?.(false);
          onChange(nextValue);
        }}
      />

      {hasUnknownValue && !isCustomMode && allowCustom ? (
        <p className="office-subtitle">{globalCopy.selectOrCustom.customValueHint}</p>
      ) : null}

      {isCustomMode ? (
        <div className="controls-row select-custom-input">
          {customLabel ? <label>{customLabel}</label> : null}
          <input
            type={inputType ?? "text"}
            value={value}
            placeholder={customPlaceholder ?? globalCopy.selectOrCustom.enterCustom}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
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
