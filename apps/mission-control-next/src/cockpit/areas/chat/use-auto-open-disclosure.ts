import { useState, type SyntheticEvent } from "react";

/**
 * State for a `<details>` that opens itself when something needs attention but never closes itself:
 * once open, only the operator closes it. Spread the result onto the element.
 */
export function useAutoOpenDisclosure(wanted: boolean) {
  const [open, setOpen] = useState(wanted);
  const [previous, setPrevious] = useState(wanted);
  if (wanted !== previous) {
    setPrevious(wanted);
    if (wanted) setOpen(true);
  }
  return {
    open,
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open),
  };
}
