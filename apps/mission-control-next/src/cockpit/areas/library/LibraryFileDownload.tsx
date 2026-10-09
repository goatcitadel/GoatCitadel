import { useEffect, useRef, useState } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { FileResource } from "./library-resources";
import { readFileDownload, saveLibraryDownload } from "./library-download";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";

export function LibraryFileDownload({ file }: { file: FileResource }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ error: boolean; message: string }>();
  const current = useRef(true), pending = useRef(false);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  async function download() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setOutcome(undefined);
    try {
      const blob = await readFileDownload(file);
      if (!current.current) return;
      saveLibraryDownload(file.relativePath, blob);
      setOutcome({ error: false, message: "Download handed to your browser. Check your browser downloads for completion." });
    } catch (cause) {
      if (current.current) setOutcome({ error: true, message: describeApiError(cause).summary });
    } finally { pending.current = false; if (current.current) setBusy(false); }
  }
  return <div className="grid gap-2">
    <p className="text-sm text-fg-secondary">Shared installation file · Last modified {file.modifiedAt}</p>
    <Button disabled={busy} onClick={() => void download()}>{busy ? "Reading download…" : "Download file"}</Button>
    {outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.message}</Callout> : null}
  </div>;
}
