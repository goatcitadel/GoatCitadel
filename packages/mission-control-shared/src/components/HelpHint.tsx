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
    <span
      className="help-hint-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={["gc-button", "help-hint", className].filter(Boolean).join(" ")}
        aria-label={label}
        aria-describedby={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {symbol}
      </button>
      <span id={id} role="tooltip" className="help-hint-tip" hidden={!open}>
        {text}
      </span>
    </span>
  );
}
