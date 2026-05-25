import { useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { parsePromptForChips, type PromptInlineSegment } from "./PromptPacksWorkbenchPage.helpers";

export function DiagnosticChipGroup({ label, values }: { label: string; values: string[] | undefined }) {
  const normalized = values?.filter(Boolean) ?? [];
  return (
    <div className="mc-pp-diagnostic-group">
      <span>{label}</span>
      <div className="mc-pp-test-meta">
        {normalized.length > 0 ? (
          normalized.map((value) => (
            <span key={value} className="mc-pp-chip diagnostic">
              {value}
            </span>
          ))
        ) : (
          <span className="mc-pp-chip">none</span>
        )}
      </div>
    </div>
  );
}

function renderInlineSegments(segments: PromptInlineSegment[]): ReactNode {
  if (segments.length === 0) {
    return null;
  }
  return segments.map((segment, segmentIndex) => {
    if (segment.kind === "text") {
      // Preserve whitespace exactly — the outer container uses `white-space:
      // pre-wrap` so no further escaping is needed.
      return <span key={segmentIndex}>{segment.value}</span>;
    }
    const label = segment.declared ? `Variable: ${segment.name}` : `Variable (not declared): ${segment.name}`;
    return (
      <code
        key={segmentIndex}
        className={`mc-next-prompt-variable${segment.declared ? "" : " is-undeclared"}`}
        data-declared={segment.declared ? "true" : "false"}
        title={label}
        aria-label={label}
      >
        {segment.raw}
      </code>
    );
  });
}

/**
 * Read-only prompt source viewer with inline variable chips and light
 * syntax cues. The flat `<pre>{prompt}</pre>` previously rendered here
 * dropped both readability (variable boundaries) and scan-ability (line
 * numbers, comment / role separation). This component restores those
 * affordances using only canonical tokens; it intentionally does NOT
 * support editing — prompt-pack tests are imported from markdown and
 * surfaced read-only.
 */
export function PromptSourceEditor({
  prompt,
  declaredPlaceholders = [],
}: {
  prompt: string | undefined;
  declaredPlaceholders?: readonly string[];
}) {
  const rows = useMemo(() => parsePromptForChips(prompt, declaredPlaceholders), [prompt, declaredPlaceholders]);
  const lineNumberWidth = useMemo(() => {
    if (rows.length === 0) {
      return 2;
    }
    return Math.max(2, String(rows[rows.length - 1]?.lineNumber ?? rows.length).length);
  }, [rows]);
  if (!prompt) {
    return (
      <pre className="mc-pp-prompt-editor" aria-label="Prompt source">
        <span className="mc-pp-prompt-empty">No prompt source available.</span>
      </pre>
    );
  }
  return (
    <pre
      className="mc-pp-prompt-editor"
      aria-label="Prompt source"
      style={{ ["--mc-pp-line-gutter" as keyof CSSProperties as string]: `${lineNumberWidth}ch` }}
    >
      {rows.map((row) => {
        const gutter = (
          <span className="mc-pp-prompt-gutter" aria-hidden="true">
            {String(row.lineNumber).padStart(lineNumberWidth, " ")}
          </span>
        );
        if (row.kind === "comment") {
          return (
            <span key={row.lineNumber} className="mc-pp-prompt-row is-comment">
              {gutter}
              <span className="mc-pp-prompt-line mc-pp-prompt-comment">{row.value || "​"}</span>
              {"\n"}
            </span>
          );
        }
        if (row.kind === "code-fence") {
          return (
            <span key={row.lineNumber} className="mc-pp-prompt-row is-code-fence">
              {gutter}
              <span className="mc-pp-prompt-line mc-pp-prompt-code">{row.value || "​"}</span>
              {"\n"}
            </span>
          );
        }
        if (row.kind === "code") {
          return (
            <span key={row.lineNumber} className="mc-pp-prompt-row is-code">
              {gutter}
              <span className="mc-pp-prompt-line mc-pp-prompt-code">{row.value || "​"}</span>
              {"\n"}
            </span>
          );
        }
        if (row.kind === "role-marker") {
          return (
            <span key={row.lineNumber} className="mc-pp-prompt-row is-role">
              {gutter}
              <span className="mc-pp-prompt-line">
                <span className="mc-pp-prompt-role">{row.role}:</span>
                {renderInlineSegments(row.segments)}
              </span>
              {"\n"}
            </span>
          );
        }
        const inline = renderInlineSegments(row.segments);
        return (
          <span key={row.lineNumber} className="mc-pp-prompt-row">
            {gutter}
            <span className="mc-pp-prompt-line">{inline ?? "​"}</span>
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

export function AssessmentThresholdBar({ passRate, threshold }: { passRate: number; threshold: number }) {
  const safePassRate = Number.isFinite(passRate) ? Math.max(0, Math.min(1, passRate)) : 0;
  const safeThreshold = Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : 0.8;
  const passing = safePassRate >= safeThreshold;
  return (
    <div className="mc-pp-threshold-bar" data-passing={passing}>
      <div className="mc-pp-threshold-bar-label">
        <span className="mc-pp-threshold-bar-eyebrow">Assessment</span>
        <strong>{(safePassRate * 100).toFixed(1)}%</strong>
        <em>threshold {(safeThreshold * 100).toFixed(0)}%</em>
        <span className={`mc-pp-threshold-bar-status${passing ? " is-passing" : " is-failing"}`}>
          {passing ? "above threshold" : "below threshold"}
        </span>
      </div>
      <div
        className="mc-pp-threshold-bar-track"
        role="img"
        aria-label={`Pass rate ${(safePassRate * 100).toFixed(1)}%, threshold ${(safeThreshold * 100).toFixed(0)}%`}
      >
        <div className="mc-pp-threshold-bar-fill" style={{ width: `${safePassRate * 100}%` }} />
        <div className="mc-pp-threshold-bar-marker" style={{ left: `${safeThreshold * 100}%` }} aria-hidden="true" />
      </div>
    </div>
  );
}
