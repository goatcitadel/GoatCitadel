import { newMessagesDividerText } from "./channel-conversation";

/**
 * Where this visit's new channel messages start, shown above the first of them. It is plain text, not an
 * announcement: the conversation's own live region owns what is read aloud.
 */
export function ChannelNewMessagesDivider({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-3 text-xs font-medium text-fg-secondary">
      <span aria-hidden="true" className="flex-1 border-t border-line" />
      <p>{newMessagesDividerText(count)}</p>
      <span aria-hidden="true" className="flex-1 border-t border-line" />
    </div>
  );
}
