import { useEffect, useMemo, useState } from "react";
import { globalCopy } from "../content/copy";
import { useUiPreferences } from "../state/ui-preferences";
import { useEmbeddedPageChrome } from "./EmbeddedPageChrome";
import { useShellDetailPanel } from "./ShellDetailPanelContext";

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
  const { mode } = useUiPreferences();
  const { registerEntry, openPanel, closePanel, isOpen } = useShellDetailPanel();
  const compact = props.compact ?? true;
  const storageKey = props.pageId ? `goatcitadel.page_guide.${props.pageId}.${props.preferenceVersion ?? "v2"}` : null;
  const [expanded, setExpanded] = useState(() => readExpandedPreference(storageKey, mode, props.defaultExpanded));

  const detailBody = useMemo(
    () => (
      <div className="page-guide-details page-guide-details-panel">
        <p className="page-guide-detail">
          <strong>{globalCopy.guideCard.when}:</strong> {props.when}
        </p>
        {props.mostCommonAction ? (
          <p className="page-guide-detail">
            <strong>{globalCopy.guideCard.mostCommonAction}:</strong> {props.mostCommonAction}
          </p>
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
    ),
    [props.actions, props.mostCommonAction, props.terms, props.when],
  );

  useEffect(() => {
    setExpanded(readExpandedPreference(storageKey, mode, props.defaultExpanded));
  }, [mode, props.defaultExpanded, storageKey]);

  useEffect(() => {
    const storage = getWindowStorage();
    if (!storageKey || !storage) {
      return;
    }
    storage.setItem(storageKey, expanded ? "expanded" : "collapsed");
  }, [expanded, storageKey]);

  useEffect(() => {
    const entryId = `page-guide:${props.pageId ?? props.what}`;
    return registerEntry({
      id: entryId,
      title: globalCopy.guideCard.title,
      kicker: globalCopy.guideCard.what,
      subtitle: props.what,
      body: detailBody,
      priority: 20,
      actions: (
        <p className="field-help page-guide-mode-note">
          {mode === "simple"
            ? "Beginner mode keeps more context available while you learn the surface."
            : "Advanced mode keeps the main workspace tight and shifts rationale into the inspector."}
        </p>
      ),
    });
  }, [detailBody, mode, props.pageId, props.what, registerEntry]);

  if (embedded) {
    return null;
  }

  return (
    <article className={`page-guide-card${compact ? " compact" : ""}`}>
      <header className="page-guide-head">
        <div className="page-guide-copy">
          <p className="page-guide-kicker">{globalCopy.guideCard.title}</p>
          <p className="page-guide-what">
            <strong>{globalCopy.guideCard.what}:</strong> {props.what}
          </p>
        </div>
        <button
          type="button"
          className="gc-button page-guide-toggle"
          onClick={() => {
            setExpanded((value) => !value);
            if (isOpen) {
              closePanel();
              return;
            }
            openPanel();
          }}
        >
          {isOpen ? "Hide details" : "Open details"}
        </button>
      </header>
      <p className="field-help page-guide-mode-note">
        {mode === "simple"
          ? "Guidance lives in the detail panel so the working surface stays clear."
          : "Advanced mode keeps rationale off-canvas until you ask for it."}
      </p>
      {!compact || expanded ? (
        <div className="page-guide-inline-summary">
          <p className="page-guide-detail">
            <strong>{globalCopy.guideCard.when}:</strong> {props.when}
          </p>
          {props.mostCommonAction ? (
            <p className="page-guide-detail">
              <strong>{globalCopy.guideCard.mostCommonAction}:</strong> {props.mostCommonAction}
            </p>
          ) : null}
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
  const storage = getWindowStorage();
  if (!storage) {
    return defaultExpanded ?? mode === "simple";
  }
  if (storageKey) {
    const raw = storage.getItem(storageKey);
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

function getWindowStorage(): Storage | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  return window.localStorage;
}
