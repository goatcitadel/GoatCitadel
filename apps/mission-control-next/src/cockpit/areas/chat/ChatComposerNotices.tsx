import type { RoutingPreflightRuntimeClass } from "@goatcitadel/contracts";
import { useModelLabel } from "../../data/use-model-label";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { ChatAttachmentChips } from "./ChatAttachmentChips";
import type { Controls } from "./ChatComposerControls";
import { routeMatchesSelection } from "./ChatModelOptionsButton";
import { presentPreflightReason } from "./chat-model-reason";

/** Plain consequence of sending through the fallback route, by where it runs. */
const RUNTIME_CLASS_LABELS: Record<RoutingPreflightRuntimeClass, string> = {
  local: "It runs on this computer.",
  cloud: "It is a cloud model, so this conversation would leave this computer.",
  unknown: "It is not recorded whether it runs on this computer or in the cloud, so this conversation may leave it.",
};

/** Attached files, the route fallback acknowledgement and the file input stay beside the draft at every width. */
export function ChatComposerNotices({ props, onChooseModel }: { props: Controls; onChooseModel?: () => void }) {
  const route = props.routePreflight;
  const routeLabel = useModelLabel(
    route?.effectiveProviderId,
    route?.effectiveModel,
    Boolean(route?.effectiveProviderId || route?.effectiveModel),
  );
  return (
    <>
      <ChatAttachmentChips
        attachments={props.pendingAttachments}
        disabled={props.historicalReadOnly || props.sending}
        onRemove={props.onRemoveAttachment}
      />
      {props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged ? (
        <div className="mb-2 space-y-2 rounded-md border border-status-waiting bg-sunken p-2 text-xs text-fg-secondary">
          <p>
            {"This message would go to "}
            {route?.effectiveProviderId || route?.effectiveModel ? routeLabel : "a fallback model (not recorded)"}
            {" instead of your chosen model. "}
            {RUNTIME_CLASS_LABELS[route?.runtimeClass ?? "unknown"] ?? RUNTIME_CLASS_LABELS.unknown}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" onClick={props.onAcknowledgeRouteBoundary}>
              Acknowledge fallback
            </Button>
            {onChooseModel ? (
              <Button size="sm" disabled={props.historicalReadOnly || props.sending} onClick={onChooseModel}>
                Choose another model
              </Button>
            ) : null}
          </div>
          {route?.degradedReason || route?.normalizationReason ? (
            <TechnicalDetails label="Fallback technical details">
              <p className="font-mono wrap-anywhere">{route?.degradedReason ?? route?.normalizationReason}</p>
            </TechnicalDetails>
          ) : null}
        </div>
      ) : null}
      {/* Uses the preflight already fetched for the composer; the notice above explains a fallback on its own. When the
          route is simply the model on the chip, the chip's tooltip carries the reason and this line stays away. */}
      {route?.effectiveModel && !props.routeBoundaryAckRequired && !routeMatchesSelection(props) ? (
        <p className="mb-1 text-xs text-fg-muted">
          Will use {routeLabel} — {presentPreflightReason(route)}
        </p>
      ) : null}
      {/* Not a live region: preflight re-runs while the draft changes, so it would re-announce on every keystroke. */}
      {route?.fileOutputNotice ? (
        <div className="mb-2 space-y-2 rounded-md border border-status-waiting bg-sunken p-2 text-xs text-fg-secondary">
          <p>{route.fileOutputNotice.message}</p>
          {route.fileOutputNotice.alternatives.length > 0 ? (
            <p>
              {"Can create files: "}
              {route.fileOutputNotice.alternatives.map((alternative) => alternative.label).join(", ")}
            </p>
          ) : null}
          {onChooseModel ? (
            <Button size="sm" disabled={props.historicalReadOnly || props.sending} onClick={onChooseModel}>
              Choose another model
            </Button>
          ) : null}
        </div>
      ) : null}
      <input
        ref={props.fileInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose files to attach"
        onChange={(event) => {
          props.onUploadFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </>
  );
}
