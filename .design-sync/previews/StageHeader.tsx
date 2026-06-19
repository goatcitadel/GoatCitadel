import { StageHeader, NativeButton } from "@goatcitadel/mission-control-next";

export const WithMetrics = () => (
  <StageHeader
    area="cowork"
    eyebrow="Cowork"
    title="Task workspace"
    description="Plan, run, and review agent tasks across your project."
    metrics={[
      { label: "Active", value: "3" },
      { label: "Queued", value: "8", delta: { value: "+2", tone: "up" } },
      { label: "Failed", value: "1", delta: { value: "-1", tone: "down" } },
    ]}
    actions={<NativeButton variant="default">New task</NativeButton>}
  />
);

export const Minimal = () => (
  <StageHeader
    area="settings"
    eyebrow="Settings"
    title="Trust & policy"
    description="Configure Wards, Vaults, and operator approvals."
  />
);
