import { StatusChip } from "@goatcitadel/mission-control-next";
import { CircleCheck, TriangleAlert, OctagonX, Radio } from "lucide-react";

const row = { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" } as const;

export const Tones = () => (
  <div style={row}>
    <StatusChip tone="success">Operational</StatusChip>
    <StatusChip tone="warning">Degraded</StatusChip>
    <StatusChip tone="critical">Offline</StatusChip>
    <StatusChip tone="live">Live</StatusChip>
    <StatusChip tone="muted">Idle</StatusChip>
    <StatusChip tone="neutral">Draft</StatusChip>
  </div>
);

export const WithIcons = () => (
  <div style={row}>
    <StatusChip tone="success" icon={<CircleCheck />}>
      Checks passing
    </StatusChip>
    <StatusChip tone="warning" icon={<TriangleAlert />}>
      Unsaved changes
    </StatusChip>
    <StatusChip tone="critical" icon={<OctagonX />}>
      Build failed
    </StatusChip>
    <StatusChip tone="live" icon={<Radio />}>
      Streaming
    </StatusChip>
  </div>
);

export const Sizes = () => (
  <div style={row}>
    <StatusChip tone="success" size="sm" icon={<CircleCheck />}>
      Small
    </StatusChip>
    <StatusChip tone="success" size="md" icon={<CircleCheck />}>
      Medium
    </StatusChip>
  </div>
);
