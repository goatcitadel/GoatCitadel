import { useEffect, useRef, useState } from "react";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { readArtifactDownload, saveLibraryDownload } from "./library-download";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

export function LibraryArtifactDownload({ artifact, workspaceId, citadelId }: { artifact: ChatGeneratedArtifactRecord; workspaceId: string; citadelId: string }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ error: boolean; text: string }>();
  const current = useRef(true), pending = useRef(false);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  async function download() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(undefined);
    try {
      const file = await readArtifactDownload(artifact, workspaceId, citadelId);
      if (!current.current) return;
      saveLibraryDownload(file.filename, file.content);
      setMessage({ error: false, text: "Verified artifact bytes handed to your browser. Check browser downloads for completion." });
    } catch (cause) { if (current.current) setMessage({ error: true, text: describeApiError(cause).summary }); }
    finally { pending.current = false; if (current.current) setBusy(false); }
  }
  return <div className="grid gap-2">
    <p className="text-sm text-fg-secondary">Version {artifact.version} · Created {artifact.createdAt} · Source {artifact.sourceSurface}</p>
    <TechnicalDetails label="Artifact provenance identifiers">
      <dl><dt>Conversation</dt><dd>{artifact.sessionId}</dd><dt>Message</dt><dd>{artifact.turnId}</dd><dt>Recorded SHA-256</dt><dd>{artifact.contentHash ?? "Unavailable"}</dd><dt>Previous artifact</dt><dd>{artifact.supersedesArtifactId ?? "No previous artifact recorded"}</dd></dl>
    </TechnicalDetails>
    <Button disabled={busy} onClick={() => void download()}>{busy ? "Verifying artifact…" : "Download artifact"}</Button>
    {message ? <Callout tone={message.error ? "error" : "info"}>{message.text}</Callout> : null}
  </div>;
}
