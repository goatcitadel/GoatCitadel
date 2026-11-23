import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { ChatSourcePassages } from "./ChatSourcePassages";

function safeSourceHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function ChatTurnSources({ sources }: { sources: ChatThreadTurnRecord["citations"] }) {
  return (
    <ul className="mt-1 divide-y divide-line-subtle">
      {sources.map((source) => {
        const href = safeSourceHref(source.url);
        return (
          <li key={source.citationId} className="py-2">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
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
