import { useId, useState } from "react";
import { useUiPreferences } from "../../state/ui-preferences";
import { parseTimestamp } from "./chat-display-helpers";
import type { ChatThreadNotice } from "./ChatThreadPrimitives";

/** Shared timestamp, notices and scroll evidence without loading optional turn renderers. */
const ACTOR_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const ACTOR_ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatActorTimestamp(timestamp: string): string {
  const parsed = parseTimestamp(timestamp);
  return parsed === null ? "Time unknown" : ACTOR_TIME_FORMATTER.format(parsed);
}

export function formatActorTimestampTitle(timestamp: string): string | undefined {
  const parsed = parseTimestamp(timestamp);
  return parsed === null ? timestamp || undefined : ACTOR_ABSOLUTE_TIME_FORMATTER.format(parsed);
}

export function ActorTimestamp({ timestamp }: { timestamp: string }) {
  return (
    <time dateTime={timestamp} title={formatActorTimestampTitle(timestamp)}>
      {formatActorTimestamp(timestamp)}
    </time>
  );
}

export function isThreadScrollNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
}

export function ChatThreadNotices({
  notices,
  scopeKey,
}: {
  notices: ChatThreadNotice[];
  /** Remounts the disclosure when the surrounding conversation changes. */
  scopeKey?: string | null;
}) {
  return <ChatThreadNoticesContents key={scopeKey ?? "thread-notices"} notices={notices} />;
}

function ChatThreadNoticesContents({ notices }: { notices: ChatThreadNotice[] }) {
  const [open, setOpen] = useState(false);
  const feedId = useId();
  if (notices.length === 0) {
    return null;
  }
  return (
    <details className="mc-next-thread-notice-feed" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary
        className="mc-next-thread-inline-button mc-next-thread-notice-feed-summary"
        aria-label={`Conversation updates (${notices.length})`}
        aria-expanded={open}
        aria-controls={feedId}
      >
        Updates ({notices.length})
      </summary>
      <ul className="mc-next-thread-notices" id={feedId}>
        {notices.map((notice) => (
          <li key={notice.id} className={`tone-${notice.tone}`}>
            <p className="mc-next-thread-meta">
              <strong>Notice</strong> · <ActorTimestamp timestamp={notice.timestamp} />
            </p>
            <NoticeContent content={notice.content} />
            <ChatNoticeTechnicalDetails notice={notice} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function NoticeContent({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  return (
    <p className="mc-next-thread-notice-content">
      {lines.map((line, index) => (
        <span key={index}>
          {index > 0 ? <br /> : null}
          {line}
        </span>
      ))}
    </p>
  );
}

/** Record identity stays available without crowding the operator-facing notice. */
export function ChatNoticeTechnicalDetails({ notice }: { notice: ChatThreadNotice }) {
  const { showTechnicalDetails } = useUiPreferences();
  if (!showTechnicalDetails || !notice.technicalDetails?.length) return null;
  return (
    <details key={notice.id} className="mt-1 text-xs">
      <summary className="cursor-pointer">Technical details</summary>
      <dl>
        {notice.technicalDetails.map((item, index) => (
          <div key={index}>
            <dt>{item.label}</dt>
            <dd className="wrap-anywhere">
              <code>{item.value}</code>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
