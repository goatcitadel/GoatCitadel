import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { formatRelativeTime } from "./ThreadedSessionGroup";

export function HistoricalConversationView({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  if (props.historicalWindowLoading) {
    return <div className="mc-next-threaded-history-state">Loading the exact historical message…</div>;
  }
  if (props.historicalWindowError) {
    return (
      <div className="mc-next-threaded-history-state error" role="alert">
        Historical message could not be loaded. {props.historicalWindowError}
      </div>
    );
  }
  const window = props.historicalWindow;
  if (!window) return null;
  if (window.anchor.state === "unavailable") {
    return (
      <div className="mc-next-threaded-history-state" role="status">
        This result is no longer available because the message was deleted or compacted.
      </div>
    );
  }
  if (window.anchor.state === "identity_mismatch") {
    return (
      <div className="mc-next-threaded-history-state error" role="alert">
        The result identity no longer matches this conversation. No newer message was substituted.
      </div>
    );
  }
  return (
    <div className="mc-next-threaded-history-list" aria-label="Historical conversation window">
      {window.hasOlder && window.olderCursor ? (
        <button
          type="button"
          className="mc-next-threaded-history-page-button"
          disabled={props.historicalContinuationLoading !== null}
          onClick={() => props.onLoadHistoricalContinuation("older")}
        >
          {props.historicalContinuationLoading === "older" ? "Loading older…" : "Load older messages"}
        </button>
      ) : null}
      {props.historicalContinuationError ? (
        <p className="mc-next-threaded-history-page-error" role="alert">
          {props.historicalContinuationError}
        </p>
      ) : null}
      {window.items.map((entry) => (
        <article
          key={`${entry.message.messageId}:${entry.sequence}`}
          className={`mc-next-threaded-history-message role-${entry.message.role}${entry.isAnchor ? " anchor" : ""}`}
          aria-current={entry.isAnchor ? "true" : undefined}
          aria-label={entry.isAnchor ? "Exact search result" : `${entry.message.role} historical message`}
        >
          <header>
            <strong>
              {entry.message.role === "assistant" ? "Assistant" : entry.message.role === "user" ? "You" : "System"}
            </strong>
            <time dateTime={entry.message.timestamp}>{formatRelativeTime(entry.message.timestamp)}</time>
          </header>
          {entry.isAnchor ? <span className="mc-next-threaded-history-anchor-label">Exact search result</span> : null}
          <p>{entry.message.content}</p>
        </article>
      ))}
      {window.hasNewer && window.newerCursor ? (
        <button
          type="button"
          className="mc-next-threaded-history-page-button"
          disabled={props.historicalContinuationLoading !== null}
          onClick={() => props.onLoadHistoricalContinuation("newer")}
        >
          {props.historicalContinuationLoading === "newer" ? "Loading newer…" : "Load newer messages"}
        </button>
      ) : null}
    </div>
  );
}
