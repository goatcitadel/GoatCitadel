import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { ChatSourcePassages } from "./ChatSourcePassages";
import { chatSelectionHref } from "./chat-selection-evidence";

function safeSourceHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function historySourceHref(source: ChatThreadTurnRecord["citations"][number]): string | null {
  if (source.sourceType !== "tool" || !source.url.startsWith("goatcitadel://chat-history?")) return null;
  const { searchParams } = new URL(source.url);
  const sessionId = searchParams.get("sessionId")?.trim();
  const messageId = searchParams.get("messageId")?.trim();
  const sequence = Number(searchParams.get("sequence"));
  if (!sessionId || !messageId || !Number.isSafeInteger(sequence) || sequence < 1) return null;
  return chatSelectionHref({ sessionId, messageId, sequence });
}

export function ChatTurnSources({ sources }: { sources: ChatThreadTurnRecord["citations"] }) {
  return (
    <ul className="mt-1 divide-y divide-line-subtle">
      {sources.map((source) => {
        const historyHref = historySourceHref(source);
        const href = historyHref ?? safeSourceHref(source.url);
        return (
          <li key={source.citationId} className="py-2">
            {href ? (
              <a
                href={href}
                target={historyHref ? undefined : "_blank"}
                rel={historyHref ? undefined : "noreferrer noopener"}
                className="font-medium text-accent underline-offset-2 hover:underline"
              >
                {source.title || "Open source"}
              </a>
            ) : (
              <span className="font-medium text-fg-secondary">{source.title || "Source"}</span>
            )}
            {source.passages?.length ? (
              <ChatSourcePassages passages={source.passages} />
            ) : source.snippet ? (
              <p className="mt-1 line-clamp-3 text-fg-muted">{source.snippet}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
