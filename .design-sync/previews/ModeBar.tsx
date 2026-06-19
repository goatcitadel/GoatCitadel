import { ModeBar } from "@goatcitadel/mission-control-next";

const caption = { fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" } as const;
const wrap = { display: "grid", gap: 6, width: 360 } as const;

export const Balanced = () => (
  <div style={wrap}>
    <span style={caption}>50% chat · 30% cowork · 20% code</span>
    <ModeBar chat={5} cowork={3} code={2} />
  </div>
);

export const CodeHeavy = () => (
  <div style={wrap}>
    <span style={caption}>10% chat · 20% cowork · 70% code</span>
    <ModeBar chat={1} cowork={2} code={7} />
  </div>
);

export const SingleMode = () => (
  <div style={wrap}>
    <span style={caption}>100% chat</span>
    <ModeBar chat={10} cowork={0} code={0} />
  </div>
);
