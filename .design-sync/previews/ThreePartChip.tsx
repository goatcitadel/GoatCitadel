import { ThreePartChip } from "@goatcitadel/mission-control-next";

const row = { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" } as const;

export const Tones = () => (
  <div style={row}>
    <ThreePartChip tone="safe" state="Healthy" mid="gateway" age="2m" />
    <ThreePartChip tone="caution" state="Degraded" mid="realtime" age="5m" />
    <ThreePartChip tone="danger" state="Down" mid="runtime" age="just now" />
    <ThreePartChip tone="nuclear" state="Breach" mid="vault" age="1m" />
  </div>
);

export const Variants = () => (
  <div style={row}>
    <ThreePartChip tone="accent" state="Live" mid="stream" />
    <ThreePartChip tone="muted" state="Idle" age="1h" />
    <ThreePartChip tone="safe" state="OK" dot={false} />
  </div>
);
