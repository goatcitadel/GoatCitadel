import { useState, type SyntheticEvent } from "react";

/**
 * State for a `<details>` that opens itself when something needs attention. Once the operator opens or closes it,
 * only the operator changes it. With `closeWhenSettled`, a disclosure that opened itself and was never touched
 * folds shut again when the attention ends (a turn's tool list after streaming), so finished turns stay compact.
 * Spread `open` and `onToggle` onto the element.
 */
export function useAutoOpenDisclosure(wanted: boolean, { closeWhenSettled = false } = {}) {
  const [open, setOpen] = useState(wanted);
  const [previous, setPrevious] = useState(wanted);
  const [touched, setTouched] = useState(false);
  if (wanted !== previous) {
    setPrevious(wanted);
    if (wanted) setOpen(true);
    else if (closeWhenSettled && !touched) setOpen(false);
  }
  return {
    open,
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
      const next = event.currentTarget.open;
      // The toggle event also fires for changes this hook made; only a change it did not make is the operator's.
      if (next !== open) setTouched(true);
      setOpen(next);
    },
  };
}
