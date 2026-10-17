import { useCallback, useState } from "react";

const NO_BREAK_SPACE = " ";

/**
 * The Inbox page's one polite announcer for decision outcomes and shortcut feedback (IN-07, IN-08). Repeating the
 * same message alternates a trailing no-break space so screen readers read it again.
 */
export function useInboxAnnouncer() {
  const [announcement, setAnnouncement] = useState({ text: "", seq: 0 });
  const announce = useCallback((text: string) => setAnnouncement((prev) => ({ text, seq: prev.seq + 1 })), []);
  const region = (
    <p role="status" data-inbox-announcer className="sr-only">
      {announcement.text}
      {announcement.seq % 2 ? NO_BREAK_SPACE : ""}
    </p>
  );
  return { announce, region };
}
