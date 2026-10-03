import { useShellHandoff } from "./use-shell-handoff";
import "./classic-layout-return.css";

/** Keep the canonical layout reachable from every Classic owner view. */
export function ClassicLayoutReturn({ sessionId }: { sessionId?: string }) {
  const handoff = useShellHandoff(["classic-layout-return", sessionId]);
  return (
    <>
      <button
        type="button"
        className="mc-next-badge mc-next-badge-button mc-next-layout-return"
        disabled={handoff.opening}
        onClick={() => handoff.request("cockpit", { sessionId })}
        aria-label="Return to Cockpit layout"
        title="Return to Cockpit layout"
      >
        {handoff.opening ? "Opening…" : "Cockpit"}
      </button>
      {handoff.error ? <span role="alert">{handoff.error}</span> : null}
      {handoff.dialog}
    </>
  );
}
