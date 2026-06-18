import { useEffect, useMemo, useState } from "react";
import { fetchPathSuggestions } from "../api/client";
import { ChangeBadge, type UiRiskLevel } from "./ChangeBadge";
import { SelectOrCustom } from "./SelectOrCustom";
import { globalCopy } from "../content/copy";

interface SmartPathInputProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  root?: string;
  limit?: number;
  placeholder?: string;
  riskLevel?: UiRiskLevel;
  helpText?: string;
}

export function SmartPathInput({
  label,
  value,
  onChange,
  root = ".",
  limit = 150,
  placeholder = "Select or type a path",
  riskLevel = "safe",
  helpText,
}: SmartPathInputProps) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoPath, setAutoPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchPathSuggestions(root, limit)
      .then((res) => {
        if (!cancelled) {
          setSuggestions(res.items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSuggestions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [limit, root]);

  const options = useMemo(() => suggestions.map((item) => ({ value: item, label: item })), [suggestions]);

  const editedManually = Boolean(autoPath && autoPath !== value);

  return (
    <div className="smart-path-input">
      <label>{label}</label>
      <div className="controls-row">
        <SelectOrCustom
          value={value}
          onChange={onChange}
          options={options}
          customLabel={label}
          customPlaceholder={placeholder}
          autoSelectFirstOption={false}
        />
        <button
          type="button"
          onClick={() => {
            const suggested = options[0]?.value;
            if (!suggested) {
              return;
            }
            setAutoPath(suggested);
            onChange(suggested);
          }}
          disabled={loading || options.length === 0}
          className="gc-button"
        >
          {globalCopy.smartPathInput.browse}
        </button>
      </div>
      <div className="controls-row">
        <ChangeBadge level={riskLevel} />
        {loading ? <span className="office-subtitle">{globalCopy.smartPathInput.loadingSuggestions}</span> : null}
        {editedManually ? (
          <span className="office-subtitle">{globalCopy.smartPathInput.editedAfterAutofill}</span>
        ) : null}
      </div>
      {helpText ? <p className="office-subtitle">{helpText}</p> : null}
    </div>
  );
}
