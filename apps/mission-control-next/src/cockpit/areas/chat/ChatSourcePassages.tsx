import type { ChatCitationRecord } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";

export function ChatSourcePassages({ passages }: { passages: NonNullable<ChatCitationRecord["passages"]> }) {
  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs font-medium text-fg-muted">{plural(passages.length, "supporting passage")}</p>
      {passages.map(({ text, toolRunId }) => (
        <blockquote
          key={`${toolRunId}:${text}`}
          className="border-s-2 border-line py-1 ps-3 text-sm text-fg-secondary wrap-anywhere whitespace-pre-wrap"
        >
          {text}
        </blockquote>
      ))}
    </div>
  );
}
