import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { describeThreadedUiError } from "../../../features/threaded-surface/threaded-error-copy";

const GENERIC = "The request failed. Check this conversation’s status before trying again.";

/**
 * Maps a raw controller error to the same plain-language copy the classic composer uses.
 * Unrecognized errors keep the generic sentence and expose the raw text only as a detail.
 */
export function ChatStreamErrorNotice({
  error,
  source,
}: {
  error: string;
  source: MissionThreadedActiveSessionSurfaceProps["streamErrorSource"];
}) {
  const mapped = describeThreadedUiError(error, source ?? "other");
  const recognized = Boolean(mapped && mapped.raw !== undefined);
  return (
    <div role="alert" className="mt-2 space-y-1 rounded-md border border-status-failed p-2 text-sm text-fg-secondary">
      <p>{recognized && mapped ? mapped.summary : /stream|disconnect|interrupted/i.test(error) ? "The response was interrupted. Check the Gateway connection and conversation status before retrying." : GENERIC}</p>
      {!recognized ? (
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">Technical detail</summary>
          <p className="mt-1 break-words font-mono">{error}</p>
        </details>
      ) : null}
    </div>
  );
}
