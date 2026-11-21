import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useState } from "react";
import type { ChatArtifactRenderRecord, ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import {
  critiqueChatGeneratedArtifact,
  renderChatGeneratedArtifact,
} from "@goatcitadel/mission-control-shared/api/chat";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { AttachmentImage, describeFailure } from "./AttachmentImage";

type Activity = "idle" | "rendering" | "critiquing";

interface RenderState {
  activity: Activity;
  renders: ChatArtifactRenderRecord[];
  message?: string;
  error?: string;
}

const IDLE: RenderState = { activity: "idle", renders: [] };
const TEXT_ONLY_MARKER = "(sent without images: the current model has no vision capability)";

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
        message: `Rendered ${plural(response.renders.length, "image")} (${viewports}).`,
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
            ? "Rendering offline images…"
            : state.activity === "critiquing"
              ? "Sending the critique…"
              : (state.message ?? "Offline PNG images at desktop and phone widths; no scripts, no network.")}
        </span>
      </div>
      {state.error ? <Callout tone="error">{state.error}</Callout> : null}
      {state.renders.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {state.renders.map((item) => (
            <li key={item.attachmentId} className="min-w-0">
              <AttachmentImage
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
