import { useEffect, useState } from "react";
import type { ChatArtifactRenderRecord, ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import {
  critiqueChatGeneratedArtifact,
  renderChatGeneratedArtifact,
} from "@goatcitadel/mission-control-shared/api/chat";
import { buildGatewayUrl, readGatewayAuthHeaders } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "./Button";

type Activity = "idle" | "rendering" | "critiquing";

interface RenderState {
  activity: Activity;
  renders: ChatArtifactRenderRecord[];
  message?: string;
  error?: string;
}

const IDLE: RenderState = { activity: "idle", renders: [] };
const TEXT_ONLY_MARKER = "(sent without images: the current model has no vision capability)";

/** The cockpit's value for the shared viewer's actions slot (see GeneratedArtifactActionsContext). */
export function renderCockpitArtifactActions(artifact: ChatGeneratedArtifactRecord) {
  // Keyed by identity so another artifact (or version) mounts with fresh state in the same commit.
  return <ArtifactRenderActions key={artifactIdentity(artifact)} artifact={artifact} />;
}

function artifactIdentity(artifact: ChatGeneratedArtifactRecord): string {
  return `${artifact.artifactId}:${artifact.contentHash ?? artifact.version}`;
}

function attachmentContentPath(attachmentId: string): string {
  return `/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/content?disposition=inline`;
}

/**
 * The gateway may live on another origin and require header auth, which a bare `<img src>` cannot
 * carry, so the PNG is fetched with the gateway auth headers into a blob URL (same pattern as the
 * Classic composer's image preview).
 */
function RenderImage({ attachmentId, alt }: { attachmentId: string; alt: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const contentPath = attachmentContentPath(attachmentId);
    setBlobUrl(null);
    setFailure(null);
    void (async () => {
      try {
        const response = await fetch(buildGatewayUrl(contentPath), { headers: readGatewayAuthHeaders(contentPath) });
        if (!response.ok) throw new Error(`Render image request failed (${response.status}).`);
        const blob = await response.blob();
        // Create the object URL only while mounted; one created after cleanup would never be revoked.
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      } catch (error) {
        if (active) setFailure(describeFailure(error));
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);

  if (failure) {
    return (
      <p role="alert" className="text-sm text-status-failed">
        {failure}
      </p>
    );
  }
  if (!blobUrl) {
    return (
      <p role="status" className="text-xs text-fg-muted">
        Loading {alt}…
      </p>
    );
  }
  return <img src={blobUrl} alt={alt} className="max-w-full rounded-md border border-line bg-sunken" />;
}

function describeFailure(error: unknown): string {
  const described = describeApiError(error);
  if (described.technical === undefined && error instanceof Error && error.message.trim()) return error.message;
  return described.summary;
}

/**
 * Render-and-look actions for an `html` generated artifact: offline PNG snapshots through the
 * gateway's render route, and a critique turn dispatched into the artifact's conversation.
 * Renders nothing for other kinds or for redacted projections (the stored bytes would not match).
 */
export function ArtifactRenderActions({
  artifact,
  workspaceId,
}: {
  artifact: ChatGeneratedArtifactRecord;
  workspaceId?: string;
}) {
  const scope = workspaceId ?? artifact.workspaceId ?? "default";
  const [state, setState] = useState<RenderState>(IDLE);

  if (
    artifact.kind !== "html" ||
    artifact.publicProjection?.contentRedacted ||
    artifact.publicProjection?.artifactRedacted
  ) {
    return null;
  }

  const busy = state.activity !== "idle";

  const render = async () => {
    setState((current) => ({ ...current, activity: "rendering", error: undefined }));
    try {
      const response = await renderChatGeneratedArtifact(artifact.artifactId, scope);
      const viewports = response.renders.map((item) => item.viewport).join(", ");
      setState({
        activity: "idle",
        renders: response.renders,
        message: `Rendered ${response.renders.length} snapshot${response.renders.length === 1 ? "" : "s"} (${viewports}).`,
      });
    } catch (error) {
      setState((current) => ({ ...current, activity: "idle", error: describeFailure(error) }));
    }
  };

  const critique = async () => {
    setState((current) => ({ ...current, activity: "critiquing", error: undefined }));
    try {
      const response = await critiqueChatGeneratedArtifact(artifact.artifactId, scope);
      setState({
        activity: "idle",
        renders: response.renders,
        message: response.visuallyInspected
          ? "Critique sent to the conversation."
          : `Critique sent to the conversation ${TEXT_ONLY_MARKER}.`,
      });
    } catch (error) {
      setState((current) => ({ ...current, activity: "idle", error: describeFailure(error) }));
    }
  };

  return (
    <section aria-label="Artifact render actions" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void render()}>
          Render
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void critique()}>
          Critique render
        </Button>
        <span role="status" className="text-xs text-fg-muted">
          {state.activity === "rendering"
            ? "Rendering offline snapshots…"
            : state.activity === "critiquing"
              ? "Sending the critique…"
              : (state.message ?? "Offline PNG snapshots at desktop and phone widths; no scripts, no network.")}
        </span>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {state.error}
        </p>
      ) : null}
      {state.renders.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {state.renders.map((item) => (
            <li key={item.attachmentId} className="min-w-0">
              <RenderImage
                attachmentId={item.attachmentId}
                alt={`${item.viewport} render (${item.width}×${item.height})`}
              />
              <p className="mt-1 text-xs text-fg-muted">
                {item.viewport} · {item.width}×{item.height}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
