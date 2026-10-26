import { useEffect, useRef, type ReactNode } from "react";
import { Callout } from "../../ui/Callout";

/**
 * What an action on the channel page answered. It is not a live region (the cockpit's live-region budget is exact), so
 * a note about something just done takes focus to be heard; a note left over from earlier does not.
 */
export function ChannelActionNote({
  message,
  fresh,
  children,
}: {
  message: string;
  fresh: boolean;
  children?: ReactNode;
}) {
  const note = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fresh) note.current?.focus();
  }, [message, fresh]);
  return (
    <div ref={note} tabIndex={-1} className="space-y-2 outline-none">
      <Callout announce={false} tone="warning">
        {message}
      </Callout>
      {children}
    </div>
  );
}
