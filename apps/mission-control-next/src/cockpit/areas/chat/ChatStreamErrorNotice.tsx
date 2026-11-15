import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { describeThreadedUiError } from "../../../features/threaded-surface/threaded-error-copy";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

const GENERIC = "The request failed. Check this conversation’s status before trying again.";
const INTERRUPTED =
  "The response was interrupted. Check the connection to GoatCitadel and the conversation status before retrying.";

/** A send that failed because no model is chosen: a reload cannot help, setup can. */
const MODEL_SETUP_ERROR = /no model provider|no model is selected/i;

/**
 * The one notice for Chat errors, in the transcript and above the build editor. It maps a raw controller error to
 * the same plain-language copy the classic composer uses; the raw text appears only in technical details.
 * `onReload` re-reads the conversation and its pending decisions; it never resends a message.
 */
export function ChatStreamErrorNotice({
  error,
  source,
  onReload,
  className = "mt-2",
}: {
  error: string;
  source: MissionThreadedActiveSessionSurfaceProps["streamErrorSource"];
  onReload?: () => void;
  className?: string;
}) {
  const mapped = describeThreadedUiError(error, source ?? "other");
  const needsModel = MODEL_SETUP_ERROR.test(error);
  const recognized = Boolean(mapped && mapped.raw !== undefined);
  return (
    <div
      role="alert"
      className={`${className} space-y-2 rounded-md border border-status-failed p-2 text-sm text-fg-secondary`}
    >
      <p>
        {recognized && mapped ? mapped.summary : /stream|disconnect|interrupted/i.test(error) ? INTERRUPTED : GENERIC}
      </p>
      {needsModel ? (
        <NativeOwnerLink href="/settings/first-run" scope="chat-model-setup" className="text-sm">
          Set up a model
        </NativeOwnerLink>
      ) : null}
      {onReload && !needsModel ? (
        <Button size="sm" onClick={onReload}>
          Reload conversation
        </Button>
      ) : null}
      {!recognized ? (
        <TechnicalDetails>
          <p className="font-mono text-xs wrap-anywhere">{error}</p>
        </TechnicalDetails>
      ) : null}
    </div>
  );
}
