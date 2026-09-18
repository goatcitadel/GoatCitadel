import { useState } from "react";
import type { RemoteWorkerAssignmentRuntime } from "@goatcitadel/contracts";
import { fetchRemoteWorkerNativeOutputArtifact } from "@goatcitadel/mission-control-shared/api/remote-workers";
import { NativeButton } from "../native-routes/primitives";
import { NativeFileDownloads } from "./NativeFileDownloads";

/** Secondary evidence download; process text is never rendered as HTML. */
export function NativeOutputDownloads({ runtime }: { runtime: RemoteWorkerAssignmentRuntime }) {
  return <><NativeProcessOutputDownloads runtime={runtime} /><NativeFileDownloads key={`${runtime.workspaceId}:${runtime.assignmentId}:${runtime.assignmentGeneration}`} runtime={runtime} /></>;
}
function NativeProcessOutputDownloads({ runtime }: { runtime: RemoteWorkerAssignmentRuntime }) {
  const summary = runtime.artifactAndEffects.value?.nativeOutputArtifacts;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  if (!summary?.nonces.length || runtime.assignmentGeneration === null) return null;
  const generation = runtime.assignmentGeneration;
  const download = async (nonce: string) => {
    if (busy) return;
    setBusy(nonce); setError(false);
    try {
      const artifact = await fetchRemoteWorkerNativeOutputArtifact(runtime.workspaceId, runtime.assignmentId, generation, nonce);
      const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.contentType }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = artifact.fileName;
      document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch { setError(true); } finally { setBusy(null); }
  };
  return <div>
    <p>Retained native output includes redacted process text and recorded execution evidence.</p>
    {summary.nonces.map((nonce, index) => <NativeButton key={nonce} disabled={busy !== null} onClick={() => void download(nonce)}>
      {busy === nonce ? "Preparing download…" : `Download native output ${index + 1}`}
    </NativeButton>)}
    {summary.truncated ? <p>Showing the latest 32 retained outputs for this assignment generation.</p> : null}
    {error ? <p role="alert">Could not download retained output. Refresh worker evidence and try again.</p> : null}
  </div>;
}
