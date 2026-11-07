import { useRef, type ComponentProps } from "react";
import {
  createDeferredDialogRuntime,
  PendingDialog,
  useDeferredDialogRuntime,
} from "@goatcitadel/mission-control-shared/components/ui/deferred-dialog";
import type { MissionThreadedConfirmations } from "./MissionThreadedConfirmations";

type Props = ComponentProps<typeof MissionThreadedConfirmations>;

const confirmationLoader = createDeferredDialogRuntime(() =>
  import("./MissionThreadedConfirmations").then(({ MissionThreadedConfirmations }) => MissionThreadedConfirmations),
);

function pendingConfirmation(props: Props) {
  if (props.archiveWorkspaceConfirmOpen)
    return {
      key: "archive",
      title: "Archive Workspace Mission Chats",
      busy: props.archiveWorkspacePending,
      dismiss: () => props.setArchiveWorkspaceConfirmOpen(false),
    };
  if (props.sessionDeleteConfirm)
    return {
      key: "delete",
      title: "Delete conversation permanently",
      busy: props.sessionControlPending === "delete",
      dismiss: () => props.setSessionDeleteConfirm(null),
    };
  if (props.activeChangePlan)
    return {
      key: `change-plan:${props.activeChangePlan.planId}`,
      title: "Review change plan",
      busy: props.changePlanActionPending,
      dismiss: () => {
        props.setActiveChangePlan(null);
        props.setLinkedDefaultChangePlan(null);
        props.setChangePlanActionError(null);
      },
    };
  if (props.capabilitySuggestionConfirm)
    return {
      key: "capability",
      title: props.capabilityConfirmationCopy?.title ?? "Confirm capability action",
      busy: props.capabilitySuggestionPending,
      dismiss: () => props.setCapabilitySuggestionConfirm(null),
    };
  if (props.forkConfirm)
    return {
      key: `fork:${props.forkConfirm.turnId}`,
      title: "Start a new conversation from this message?",
      busy: props.forkPending,
      dismiss: () => props.setForkConfirm(null),
    };
  return null;
}

/** Load view code on demand. The frame's existing confirmation owners retain all decisions and state. */
export function DeferredMissionThreadedConfirmations(props: Props) {
  const pending = props.visible ? pendingConfirmation(props) : null;
  const ownsOAuthFlow = Boolean(props.changePlanOAuthFlow && props.activeChangePlan?.planId === props.changePlanOAuthFlow.planId);
  const { runtime: Confirmations, failed } = useDeferredDialogRuntime(Boolean(pending || ownsOAuthFlow), confirmationLoader);
  const handoff = useRef(false);
  handoff.current = Boolean(pending && Confirmations);
  if (Confirmations) return <Confirmations {...props} />;
  if (!pending) return null;

  return (
    <PendingDialog
      key={pending.key}
      title={pending.title}
      closeLabel="Cancel"
      className="fixed inset-x-4 top-4 m-0 mx-auto max-w-xl rounded-lg border border-line bg-overlay p-4 text-fg shadow-overlay backdrop:bg-scrim sm:top-24"
      dismissDisabled={pending.busy}
      onDismiss={pending.dismiss}
      handoff={handoff}
    >
      <p className="mt-3 text-sm" role={failed ? "alert" : "status"}>
        {failed ? "Confirmation controls could not load." : "Loading confirmation controls…"}
      </p>
    </PendingDialog>
  );
}
