import { CircleHelp } from "lucide-react";
import { inboxCountTitle } from "../areas/inbox/inbox-presentation";

/** inboxCountLabel's marker for "a read failed and nothing is known". */
const UNKNOWN_COUNT = "?";

/**
 * SH-29: one Inbox badge on the expanded rail, the collapsed rail and the phone tab bar. The count also lives in the
 * control's accessible name (inboxNavigationLabel), so the badge itself is hidden from assistive technology; an
 * unknown count shows an icon with a "Count unknown" tooltip instead of a bare "?".
 */
export function InboxCountBadge({ count, className = "" }: { count: string; className?: string }) {
  const unknown = count === UNKNOWN_COUNT;
  return (
    <span
      aria-hidden="true"
      title={unknown ? "Count unknown" : inboxCountTitle(count)}
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-accent-ink ${className}`}
    >
      {unknown ? <CircleHelp aria-hidden="true" className="size-3" /> : count}
    </span>
  );
}
