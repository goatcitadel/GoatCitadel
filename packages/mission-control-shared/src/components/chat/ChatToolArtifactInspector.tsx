import { useState } from "react";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { fetchChatToolArtifact } from "../../api/client";
import { ChatToolDiffBlock } from "./ChatToolDiffBlock";
import { extractUnifiedDiffFromToolRun } from "./chat-tool-diff";

function formatBytes(value?: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatToolArtifactInspector(props: {
  artifactId: string;
  workspaceId: string;
  artifactPath?: string;
  originalByteLength?: number;
  /**
   * The tool run this artifact belongs to. Optional so existing call sites that
   * only have the artifact pointer keep working unchanged. When present and its
   * `result` carries a qualifying unified diff (see `extractUnifiedDiffFromToolRun`),
   * the diff renders with +/- coloring INSTEAD OF the raw fetched-artifact text dump.
   */
  run?: ChatToolRunRecord;
}) {
  const { artifactId, workspaceId, artifactPath, originalByteLength, run } = props;
  const diff = run ? extractUnifiedDiffFromToolRun(run) : null;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string | undefined>(undefined);

  const handleToggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (content !== null || loading) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetchChatToolArtifact(artifactId, workspaceId);
      setContent(response.content);
      setContentType(response.artifact.contentType);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chat-tool-artifact-inspector">
      <button type="button" className="gc-button chat-tool-artifact-link" onClick={() => void handleToggle()}>
        {open ? "Hide raw artifact" : "Inspect raw artifact"}
      </button>
      {artifactPath || originalByteLength ? (
        <span className="chat-tool-artifact-caption">
          {[artifactPath, formatBytes(originalByteLength)].filter(Boolean).join(" · ")}
        </span>
      ) : null}
      {open ? (
        <div className="chat-tool-artifact-panel">
          {loading ? <p>Loading artifact...</p> : null}
          {error ? <p>{error}</p> : null}
          {contentType ? <p className="chat-tool-artifact-caption">Content type: {contentType}</p> : null}
          {content ? diff !== null ? <ChatToolDiffBlock diff={diff} /> : <pre>{content}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
