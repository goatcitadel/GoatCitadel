import { useId, useState } from "react";

interface HelpHintProps {
  label: string;
  text: string;
  symbol?: string;
  className?: string;
}

export function HelpHint({ label, text, symbol = "?", className }: HelpHintProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="help-hint-wrap">
      <button
        type="button"
        className={["gc-button", "help-hint", className].filter(Boolean).join(" ")}
        aria-label={label}
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
      >
        {symbol}
      </button>
      {open ? (
        <span id={id} role="tooltip" className="help-hint-tip">
          {text}
        </span>
      ) : null}
    </span>
  );
}
