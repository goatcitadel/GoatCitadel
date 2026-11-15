import { useCallback, useEffect, useRef, useState } from "react";
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";

/**
 * The local clock passing an approval's deadline is not proof the Gateway expired it: the approval may have been decided
 * elsewhere while this tab was offline. Once the deadline passes, read the record again once, never joining an older
 * in-flight read, and let the caller follow what the record says. `check` reads again on demand.
 */
export function useApprovalDeadlineCheck({
  approvalId,
  lapsed,
  read,
}: {
  approvalId: string | undefined;
  /** The deadline has passed on this clock while the record still reads as pending. */
  lapsed: boolean;
  read: () => Promise<unknown>;
}): { checking: boolean; check: () => void } {
  const [checking, setChecking] = useState(false);
  const checkedFor = useRef<string | undefined>(undefined);
  const readRef = useRef(read);
  readRef.current = read;
  const check = useCallback(() => {
    setChecking(true);
    // The read settles its own failure into the record query; this only tracks that it is under way.
    void withFreshReads(() => readRef.current())
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (!lapsed || !approvalId || checkedFor.current === approvalId) return;
    checkedFor.current = approvalId;
    check();
  }, [lapsed, approvalId, check]);
  return { checking, check };
}
