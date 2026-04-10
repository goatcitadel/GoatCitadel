import { useEffect, useState } from "react";
import { globalCopy } from "../content/copy";
import { useUiPreferences } from "../state/ui-preferences";
import { useEmbeddedPageChrome } from "./EmbeddedPageChrome";

interface PageGuideCardProps {
  pageId?: string;
  what: string;
  when: string;
  mostCommonAction?: string;
  actions: string[];
  terms?: Array<{ term: string; meaning: string }>;
  compact?: boolean;
  defaultExpanded?: boolean;
  preferenceVersion?: string;
}

export function PageGuideCard(props: PageGuideCardProps) {
  const embedded = useEmbeddedPageChrome();
  if (embedded) {
    return null;
  }
  const { mode } = useUiPreferences();
  const compact = props.compact ?? true;
  const storageKey = props.pageId ? `goatcitadel.page_guide.${props.pageId}.${props.preferenceVersion ?? "v2"}` : null;
  const [expanded, setExpanded] = useState(() => readExpandedPreference(storageKey, mode, props.defaultExpanded));

  useEffect(() => {
    setExpanded(readExpandedPreference(storageKey, mode, props.defaultExpanded));
  }, [mode, props.defaultExpanded, storageKey]);

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(storageKey, expanded ? "expanded" : "collapsed");
  }, [expanded, storageKey]);

  return (
    <article className={`page-guide-card${compact ? " compact" : ""}`}>
      <header className="page-guide-head">
        <div className="page-guide-copy">
          <p className="page-guide-kicker">{globalCopy.guideCard.title}</p>
          <p className="page-guide-what"><strong>{globalCopy.guideCard.what}:</strong> {props.what}</p>
        </div>
        <button type="button" className="gc-button page-guide-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Hide details" : "Show details"}
        </button>
      </header>
      <p className="field-help page-guide-mode-note">
        {mode === "simple"
          ? "Beginner mode keeps more guidance visible on first pass."
          : "Advanced mode keeps guidance compact unless you expand it."}
      </p>
      {!compact || expanded ? (
        <div className="page-guide-details">
          <p className="page-guide-detail"><strong>{globalCopy.guideCard.when}:</strong> {props.when}</p>
          {props.mostCommonAction ? (
            <p className="page-guide-detail"><strong>{globalCopy.guideCard.mostCommonAction}:</strong> {props.mostCommonAction}</p>
          ) : null}
          <div className="page-guide-grid">
            <div className="page-guide-group">
              <p className="page-guide-label">{globalCopy.guideCard.actions}</p>
              <ol className="page-guide-list">
                {props.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ol>
            </div>
            {props.terms && props.terms.length > 0 ? (
              <div className="page-guide-group">
                <p className="page-guide-label">{globalCopy.guideCard.terms}</p>
                <ul className="page-guide-list terms">
                  {props.terms.map((item) => (
                    <li key={item.term}>
                      <strong>{item.term}:</strong> {item.meaning}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function readExpandedPreference(
  storageKey: string | null,
  mode: "simple" | "advanced",
  defaultExpanded?: boolean,
): boolean {
  if (typeof window === "undefined") {
    return defaultExpanded ?? mode === "simple";
  }
  if (storageKey) {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === "expanded") {
      return true;
    }
    if (raw === "collapsed") {
      return false;
    }
  }
  if (typeof defaultExpanded === "boolean") {
    return defaultExpanded;
  }
  return mode === "simple";
}
