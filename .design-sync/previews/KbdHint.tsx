import { KbdHint } from "@goatcitadel/mission-control-next";

const row = { display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" } as const;

export const WithLabel = () => (
  <div style={row}>
    <KbdHint label="Open palette" keys={["Cmd", "K"]} />
    <KbdHint label="Quick search" keys={["/"]} />
  </div>
);

export const KeysOnly = () => (
  <div style={row}>
    <KbdHint keys={["Cmd", "Shift", "P"]} />
    <KbdHint keys={["Esc"]} />
  </div>
);

export const Sizes = () => (
  <div style={row}>
    <KbdHint keys={["Cmd", "K"]} size="sm" />
    <KbdHint keys={["Cmd", "K"]} size="md" />
  </div>
);
