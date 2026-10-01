import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useDemoBootstrap } from "../../../features/native-routes/settings/use-demo-bootstrap";
import { DEMO_BOOTSTRAP_CONSEQUENCE } from "../../../features/native-routes/settings/demo-bootstrap-binding";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { McpDraftLeave } from "./McpDraftLeave";

export function FirstRunDemo({ workspaceId }: { workspaceId: string }) {
  const control = useDemoBootstrap(workspaceId),
    leave = useDraftLeave();
  const { navigate } = useCockpitRoute();
  const { setActiveWorkspaceId, setActiveCitadelId } = useUiPreferences();
  const open = () =>
    leave.request(
      () =>
        void control.open((destination) => {
          setActiveCitadelId(destination.citadelId);
          setActiveWorkspaceId(destination.workspaceId);
          navigate(
            `/chat?sessionId=${encodeURIComponent(destination.sessionId)}&projectId=${encodeURIComponent(destination.projectId)}`,
          );
        }),
    );
  return (
    <section aria-label="Local demo setup" className="grid gap-3 rounded-lg border border-line bg-raised p-4">
      <h2 className="font-display text-lg font-semibold text-fg">Try a local demo</h2>
      <p className="text-sm text-fg-secondary">{DEMO_BOOTSTRAP_CONSEQUENCE}</p>
      <p className="text-sm text-fg-secondary">
        Sample records: {control.state?.status?.replaceAll("_", " ") ?? "Not checked"}. This is not model execution or
        completed approval evidence.
      </p>
      {control.message || control.attempt ? (
        <p role="status" className="text-sm text-fg-secondary">
          {control.attempt?.message ?? control.message}
        </p>
      ) : null}
      {control.receipt ? (
        <div className="rounded-md border border-line p-3 text-sm text-fg-secondary">
          <p>Last acknowledged preparation: {control.receipt.status}.</p>
          <ul className="list-disc pl-5">
            {control.receipt.notes.map((note, index) => (
              <li key={index} className="break-words">
                {note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="grid gap-2 text-sm text-fg-secondary">
        {control.state?.starterPrompts?.slice(0, 3).map((prompt) => (
          <li key={prompt.title}>
            <p className="font-medium text-fg">{prompt.title}</p>
            <p>{prompt.prompt}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button disabled={control.locked || control.loading || !control.state} onClick={control.begin}>
          Review demo preparation
        </Button>
        <Button
          disabled={control.attempt?.phase === "pending" || control.loading}
          onClick={() => void control.refresh()}
        >
          Refresh demo state
        </Button>
        <Button
          disabled={control.attempt?.phase === "pending" || control.loading || !control.state?.sessions?.length}
          onClick={open}
        >
          Open recorded demo
        </Button>
      </div>
      <Dialog
        open={Boolean(control.review)}
        title="Prepare local demo"
        description={DEMO_BOOTSTRAP_CONSEQUENCE}
        onOpenChange={(value) => {
          if (!value) control.cancel();
        }}
      >
        <p className="mb-4 break-words text-sm text-fg-secondary">
          Workspace: {control.review?.state.workspace?.name ?? "The Gateway selects or creates GoatCitadel Demo"}.
          Existing data can be reused; this operation does not accept an expected revision.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={control.locked} onClick={() => void control.confirm()}>
            Confirm demo preparation
          </Button>
          <Button onClick={control.cancel}>Cancel</Button>
        </div>
      </Dialog>
      <McpDraftLeave {...leave.dialogProps} />
    </section>
  );
}
