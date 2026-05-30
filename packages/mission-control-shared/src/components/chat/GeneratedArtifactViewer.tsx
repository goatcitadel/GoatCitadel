import { useEffect, useId, useMemo, useState } from "react";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { StatusChip } from "../StatusChip";
import { AssistantMessageRenderer } from "./AssistantMessageRenderer";

function formatArtifactTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function hardenMermaidSvg(svg: string): string {
  // Defence-in-depth on top of mermaid's securityLevel: "strict". When a DOM is
  // available, strip scripting vectors from the rendered SVG before it is set via
  // dangerouslySetInnerHTML. When no DOM is available (SSR), fall back to the raw
  // mermaid-strict output, which is only ever set on the client anyway.
  if (typeof window === "undefined") {
    return svg;
  }
  try {
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = parsed.documentElement;
    if (!root || parsed.getElementsByTagName("parsererror").length > 0) {
      return svg;
    }
    root.querySelectorAll("script, foreignObject").forEach((node) => node.remove());
    root.querySelectorAll("*").forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.toLowerCase().startsWith("on")) {
          element.removeAttribute(attribute.name);
        }
      }
    });
    return new XMLSerializer().serializeToString(root);
  } catch {
    return svg;
  }
}

function MermaidArtifactRenderer({ source }: { source: string }) {
  const renderId = useId().replace(/[:]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    void import("mermaid")
      .then(async (module) => {
        const mermaid = module.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
        });
        const rendered = await mermaid.render(`generated-artifact-${renderId}`, source);
        if (!cancelled) {
          setSvg(hardenMermaidSvg(rendered.svg));
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to render Mermaid output.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [renderId, source]);

  if (error) {
    return (
      <div className="generated-artifact-fallback">
        <p className="generated-artifact-fallback-title">Mermaid render failed</p>
        <p className="generated-artifact-fallback-copy">{error}</p>
        <pre className="generated-artifact-code-block">{source}</pre>
      </div>
    );
  }

  if (!svg) {
    return <p className="generated-artifact-loading">Rendering diagram…</p>;
  }

  return <div className="generated-artifact-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function GeneratedArtifactViewer({
  artifact,
  compact = false,
}: {
  artifact: ChatGeneratedArtifactRecord;
  compact?: boolean;
}) {
  const artifactLanguage = artifact.language?.trim() || (artifact.kind === "text" ? "text" : undefined);
  const artifactMeta = useMemo(
    () =>
      [
        artifact.sourceSurface,
        artifact.providerId && artifact.model ? `${artifact.providerId} / ${artifact.model}` : artifact.model,
        `Saved ${formatArtifactTimestamp(artifact.createdAt)}`,
      ].filter((value): value is string => Boolean(value)),
    [artifact.createdAt, artifact.model, artifact.providerId, artifact.sourceSurface],
  );

  return (
    <article className={`generated-artifact-viewer${compact ? " compact" : ""}`}>
      <header className="generated-artifact-header">
        <div className="generated-artifact-copy">
          <p className="generated-artifact-kicker">Generated artifact</p>
          <h3>{artifact.title}</h3>
          <div className="generated-artifact-chip-row">
            <StatusChip tone="muted">{artifact.kind}</StatusChip>
            <StatusChip tone="muted">v{artifact.version}</StatusChip>
            {artifactLanguage ? <StatusChip tone="muted">{artifactLanguage}</StatusChip> : null}
            {artifact.supersedesArtifactId ? <StatusChip tone="warning">Supersedes prior version</StatusChip> : null}
          </div>
        </div>
        <div className="generated-artifact-meta">
          {artifactMeta.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </header>

      <div className={`generated-artifact-body kind-${artifact.kind}`}>
        {artifact.kind === "markdown" ? <AssistantMessageRenderer role="assistant" content={artifact.content} /> : null}
        {artifact.kind === "html" ? (
          <iframe title={artifact.title} className="generated-artifact-frame" sandbox="" srcDoc={artifact.content} />
        ) : null}
        {artifact.kind === "mermaid" ? <MermaidArtifactRenderer source={artifact.content} /> : null}
        {artifact.kind === "code" || artifact.kind === "text" ? (
          <pre className="generated-artifact-code-block">{artifact.content}</pre>
        ) : null}
      </div>
    </article>
  );
}
