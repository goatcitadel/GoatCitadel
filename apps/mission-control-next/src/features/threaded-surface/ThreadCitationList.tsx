import { useId, useState } from "react";
import type { ChatCitationRecord } from "@goatcitadel/contracts";
import {
  formatMemoryCitationMeta,
  formatMemorySignals,
  isMemoryCitation,
  normalizeCitationDisplayText,
} from "@goatcitadel/mission-control-shared/components/chat/assistant-display-text";

function isSafeCitationHref(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatCitationSource(citation: ChatCitationRecord): string {
  if (isMemoryCitation(citation)) {
    if (citation.knowledge) {
      return citation.knowledge.retrievalMode === "full_text" ? "memory full text" : "memory retrieval";
    }
    return "memory";
  }
  if (citation.knowledge) {
    return citation.knowledge.retrievalMode === "full_text" ? "knowledge full text" : "knowledge retrieval";
  }
  return citation.sourceType ?? "source";
}

export function ThreadCitationList({ citations }: { citations: ChatCitationRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  const overflowId = useId();
  if (citations.length === 0) {
    return null;
  }
  const collapsedLimit = 6;
  const primaryCitations = citations.slice(0, collapsedLimit);
  const overflowCitations = citations.slice(collapsedLimit);
  const renderCitation = (citation: ChatCitationRecord, index: number) => {
    const label = normalizeCitationDisplayText(citation.title) || citation.url;
    const snippet = normalizeCitationDisplayText(citation.snippet);
    const source = formatCitationSource(citation);
    const safeHref = isSafeCitationHref(citation.url);
    const memoryWhyUsed = isMemoryCitation(citation)
      ? (citation.provenance?.selectionReason ?? "Memory selection reason was not recorded.")
      : null;
    const memoryMeta = formatMemoryCitationMeta(citation.provenance);
    const memorySignals = formatMemorySignals(citation.provenance?.matchSignals);
    const memoryCitation = isMemoryCitation(citation);
    return (
      <article
        key={citation.citationId || `${citation.url}-${index}`}
        className={memoryCitation ? "is-memory" : undefined}
      >
        <div>
          <strong>{index + 1}</strong>
          {safeHref ? (
            <a href={citation.url} target="_blank" rel="noreferrer">
              {label}
            </a>
          ) : (
            <span>{label}</span>
          )}
        </div>
        <p>
          {source}
          {snippet ? ` · ${snippet}` : ""}
        </p>
        {memoryWhyUsed ? <p className="citation-memory-reason">Why used: {memoryWhyUsed}</p> : null}
        {memoryMeta ? <p className="citation-memory-meta">{memoryMeta}</p> : null}
        {memorySignals ? <p className="citation-memory-meta">{memorySignals}</p> : null}
      </article>
    );
  };
  return (
    <div className="mc-next-thread-citations" aria-label="Citations for this answer">
      {primaryCitations.map(renderCitation)}
      {overflowCitations.length > 0 ? (
        <>
          <div id={overflowId} className="mc-next-thread-citations-overflow" hidden={!expanded}>
            {expanded
              ? overflowCitations.map((citation, index) => renderCitation(citation, collapsedLimit + index))
              : null}
          </div>
          <button
            type="button"
            className="mc-next-thread-inline-button mc-next-thread-citations-toggle"
            aria-expanded={expanded}
            aria-controls={overflowId}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show fewer citations" : `Show ${overflowCitations.length} more citations`}
          </button>
        </>
      ) : null}
    </div>
  );
}
