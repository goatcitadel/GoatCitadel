import { useEffect, useState } from "react";
import { discoverTerm, SEARCH_PAUSE_MS } from "./discover-view";

/**
 * The term Discover asks the Gateway for. Typing is not sent as it happens: a term of two or more characters is sent
 * once the typing has paused for `SEARCH_PAUSE_MS`, and until then the list for the last term (or the plain list) stays.
 * Emptying the box, or shortening it under two characters, goes back to the plain list at once, because that list is
 * not a search. A box that already holds a term when the view opens searches it straight away.
 */
export function useSettledTerm(search: string): string {
  const wanted = discoverTerm(search);
  const [settled, setSettled] = useState(wanted);
  useEffect(() => {
    if (wanted === "") {
      setSettled("");
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(wanted), SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [wanted]);
  return wanted === "" ? "" : settled;
}
