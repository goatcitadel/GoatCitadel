/** A draft this long still sends; the notice only warns that the reply may be slow or cost more. */
export const LONG_INPUT_NOTICE_CHARS = 20_000;

export function ChatLongInputNotice({ draft }: { draft: string }) {
  if (draft.length < LONG_INPUT_NOTICE_CHARS) return null;
  return (
    <p role="status" className="mb-2 text-sm text-fg-secondary">
      This message is {draft.length.toLocaleString("en-US")} characters long. You can still send it, but the reply may
      be slow or cost more.
    </p>
  );
}
