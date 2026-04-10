import { useId, useState } from "react";

interface HelpHintProps {
  label: string;
  text: string;
}

export function HelpHint({ label, text }: HelpHintProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="help-hint-wrap">
      <button
        type="button"
        className="gc-button help-hint"
        aria-label={label}
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
      >
        ?
      </button>
      {open ? (
        <span id={id} role="tooltip" className="help-hint-tip">
          {text}
        </span>
      ) : null}
    </span>
  );
}
