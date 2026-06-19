import { ErrorState, NativeButton } from "@goatcitadel/mission-control-next";

export const Inline = () => (
  <ErrorState
    title="Couldn't reach the gateway"
    description="The runtime is still starting up. Retry in a moment."
    primaryAction={<NativeButton variant="outline">Retry</NativeButton>}
  />
);

export const Caution = () => (
  <ErrorState
    tone="caution"
    title="Partial results"
    description="Some sources timed out; showing what loaded so far."
  />
);

export const Panel = () => (
  <ErrorState
    size="default"
    title="Run failed"
    description="The agent hit an unrecoverable error while executing the task. Check the logs or try again."
    primaryAction={<NativeButton variant="default">Retry run</NativeButton>}
    secondaryActions={<NativeButton variant="ghost">View logs</NativeButton>}
  />
);
