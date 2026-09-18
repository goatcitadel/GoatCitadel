import { useEffect, useRef, useState } from "react";
import type { RemoteWorkerAssignmentRuntime } from "@goatcitadel/contracts";
import { fetchNativeFileList, downloadNativeFile, type NativeFileList, type NativeFileEntry } from "@goatcitadel/mission-control-shared/api/remote-worker-native-files";
import { NativeButton } from "../native-routes/primitives";
export function NativeFileDownloads({ runtime }: { runtime: RemoteWorkerAssignmentRuntime }) {
  const summary = runtime.artifactAndEffects.value?.nativeFileArtifacts;
  const [lists, setLists] = useState<Record<string, NativeFileList>>({}), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!summary?.nonces.length || runtime.assignmentGeneration === null) return null;
  const scope = (nonce: string) => ({ registryWorkspaceId: runtime.workspaceId, assignmentId: runtime.assignmentId, assignmentGeneration: runtime.assignmentGeneration!, nonce });
  const act = async (nonce: string, file?: NativeFileEntry) => {
    if (busy) return; setBusy(true); setError(false);
    try {
      if (!file) { const list = await fetchNativeFileList(scope(nonce)); if (mounted.current) setLists(previous => ({ ...previous, [nonce]: list })); }
      else {
        const artifact = await downloadNativeFile(scope(nonce), file); if (!mounted.current) return;
        const url = URL.createObjectURL(artifact.blob), anchor = document.createElement("a");
        anchor.href = url; anchor.download = artifact.fileName; document.body.append(anchor);
        try { anchor.click(); } finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
      }
    } catch { if (mounted.current) setError(true); } finally { if (mounted.current) setBusy(false); }
  };
  return <section aria-label="Generated native files">
    <p>Generated files are available after artifact verification. Downloads preserve the original bytes.</p>
    {summary.nonces.map((nonce, index) => <div key={nonce}>
      {lists[nonce] ? <ul>{lists[nonce]!.files.map(file => <li key={file.fileIndex}>
        <span style={{ overflowWrap: "anywhere" }}>{file.logicalPath} · {file.byteCount.toLocaleString()} bytes </span>
        <NativeButton aria-label={`Download ${file.logicalPath}`} disabled={busy} onClick={() => void act(nonce, file)}>Download file</NativeButton>
      </li>)}</ul> : <NativeButton disabled={busy} onClick={() => void act(nonce)}>View generated files {index + 1}</NativeButton>}
    </div>)}
    {busy ? <p role="status">Preparing files…</p> : null}
    {error ? <p role="alert">Files are unavailable or could not be verified. Refresh worker evidence and try again.</p> : null}
    {summary.truncated ? <p>Showing the latest 32 file batches for this assignment.</p> : null}
  </section>;
}
