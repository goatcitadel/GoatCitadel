import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { buildClassicOwnerUrl } from "../../app/classic-owner-url";
import { useUnsettledChatContextMutation } from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import { CHAT_CONTEXT_HANDOFF_WARNING, useShellHandoff } from "../../app/use-shell-handoff";
import { useDraftLeaveDialogState } from "../../features/native-routes/library/DraftLeaveDialog";
import { buildShellSwitchUrl } from "../../shell-preference";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
export function useCockpitShellSwitch(sessionId?: string | null) {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const owner = useShellHandoff([activeCitadelId, activeWorkspaceId, sessionId]);
  return {
    /** An explicit layout choice: Classic becomes the saved default. */
    request: () => owner.request("classic", { sessionId }),
    /** A task detour: Classic opens for this visit and the saved default stays Cockpit. */
    visit: () =>
      owner.request("classic", {
        href: buildClassicOwnerUrl(buildShellSwitchUrl(window.location.href, "classic", sessionId)),
      }),
    feedback: <ShellSwitchFeedback owner={owner} floating />,
  };
}
/**
 * `floating` pins the status above the shell for owners rendered outside the visible layout (the navigation
 * provider and the phone tab bar render after the 100dvh shell, so inline text would land below the fold).
 */
export function ShellSwitchFeedback({
  owner,
  floating = false,
}: {
  owner: ReturnType<typeof useShellHandoff>;
  floating?: boolean;
}) {
  const state = useDraftLeaveDialogState(owner.dialogProps);
  const status =
    owner.opening || owner.error ? (
      <>
        {owner.opening ? (
          <span role="status" className="block text-sm text-fg-muted">
            Opening view…
          </span>
        ) : null}
        {owner.error ? (
          <span role="alert" className="block text-sm text-status-failed">
            {owner.error}
          </span>
        ) : null}
      </>
    ) : null;
  return (
    <>
      {floating && status ? (
        <div className="fixed inset-x-4 bottom-20 z-70 mx-auto w-fit max-w-full rounded-md border border-line bg-overlay px-3 py-2 shadow-overlay sm:bottom-4">
          {status}
        </div>
      ) : (
        status
      )}
      <Dialog
        open={owner.dialogProps.open}
        title="Unsaved changes"
        description={state.description}
        onOpenChange={(open) => {
          if (!open && !state.saving) owner.dialogProps.onCancel();
        }}
      >
        {state.error ? (
          <p role="alert" className="text-sm text-status-failed">
            {state.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {state.canSave ? (
            <Button disabled={state.saving} onClick={() => void state.saveAndContinue()}>
              Save and continue
            </Button>
          ) : null}
          {state.canKeep ? (
            <Button disabled={state.saving} onClick={owner.dialogProps.onContinue}>
              Keep draft and close
            </Button>
          ) : null}
          <Button variant="danger" disabled={state.saving} onClick={state.discard}>
            Discard changes
          </Button>
          <Button disabled={state.saving} onClick={owner.dialogProps.onCancel}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/** The shell announces retained uncertainty once, independently of its navigation entrypoints. */
export function ChatContextHandoffNotice() {
  const pending = useUnsettledChatContextMutation();
  return pending ? (
    <p role="status" className="border-b border-line bg-sunken px-3 py-2 text-sm text-fg-secondary">
      {CHAT_CONTEXT_HANDOFF_WARNING}
    </p>
  ) : null;
}
