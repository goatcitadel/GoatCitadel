import { createContext, useContext, useId, type ReactNode } from "react";
import { APPROVAL_PAUSED_NOTE } from "./chat-vocabulary";

/** True inside a paused decision area, so a confirmation dialog in a portal can pause too. */
const ConnectionLostContext = createContext(false);
export const useApprovalConnectionLost = (): boolean => useContext(ConnectionLostContext);

/**
 * Wraps the decision controls. While GoatCitadel is unreachable the controls inside are disabled and the plain
 * sentence says why; the screen announces the outage through its connection notice, so this adds no live region.
 * The wrapper stays in place when the connection returns, so what is inside never remounts.
 */
export function ChatApprovalPausedFieldset({ paused, children }: { paused?: boolean; children: ReactNode }) {
  const noteId = useId();
  return (
    <ConnectionLostContext.Provider value={Boolean(paused)}>
      <fieldset disabled={paused} aria-describedby={paused ? noteId : undefined} className="m-0 min-w-0 border-0 p-0">
        {paused ? (
          <p id={noteId} className="mb-2 text-fg-secondary">
            {APPROVAL_PAUSED_NOTE}
          </p>
        ) : null}
        {children}
      </fieldset>
    </ConnectionLostContext.Provider>
  );
}
