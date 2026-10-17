import { useEffect, useId, useState, type ChangeEvent } from "react";
import { Button } from "../../ui/Button";

/** Matches the vault editor's own auto-hide; the countdown makes that promise visible. */
export const REVEAL_SECONDS = 30;

const inputClass =
  "block min-h-10 w-full min-w-0 flex-1 rounded-md border border-line-control bg-canvas px-3 py-2 text-sm text-fg";

/**
 * The secret entry field with a Show toggle. Visibility is local to this mount, so closing the editor hides the
 * value again. The value is never logged or stored here; it lives only in the editor draft.
 */
export function SecretValueInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="block text-sm text-fg-secondary">
      <label htmlFor={`${id}-value`}>Secret value</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={`${id}-value`}
          type={visible ? "text" : "password"}
          className={inputClass}
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          onChange={onChange}
        />
        <Button
          size="sm"
          aria-pressed={visible}
          aria-controls={`${id}-value`}
          onClick={() => setVisible((current) => !current)}
        >
          Show value
        </Button>
      </div>
    </div>
  );
}

/**
 * A revealed value with Copy and a visible countdown. The countdown ticks every second and calls `onHide` at zero;
 * its interval is cleared when the reveal ends, the inspection closes or the route changes (unmount).
 */
export function RevealedSecret({ value, onHide }: { value: string; onHide: () => void }) {
  const [remaining, setRemaining] = useState(REVEAL_SECONDS);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const statusId = useId();

  useEffect(() => {
    const interval = globalThis.setInterval(() => setRemaining((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => globalThis.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (remaining === 0) onHide();
  }, [remaining, onHide]);

  async function copyValue() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <div className="space-y-2">
      <code className="block whitespace-pre-wrap break-all rounded-md bg-sunken p-3 font-mono text-sm text-fg">
        {value}
      </code>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" aria-describedby={statusId} onClick={() => void copyValue()}>
          {copyStatus === "copied" ? "Copied" : "Copy value"}
        </Button>
        <p className="text-xs text-fg-muted">
          <span className="tabular-nums">Hides in {remaining}s</span>
        </p>
      </div>
      <p id={statusId} className={copyStatus === "failed" ? "text-xs text-status-failed" : "sr-only"}>
        {copyStatus === "failed"
          ? "Copy is unavailable. Select the value and copy it manually."
          : copyStatus === "copied"
            ? "Copied to the clipboard."
            : ""}
      </p>
    </div>
  );
}
