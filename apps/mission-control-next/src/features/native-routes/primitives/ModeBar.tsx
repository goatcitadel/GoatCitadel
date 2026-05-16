import { useMemo } from "react";

export type ModeBarProps = {
  chat: number;
  cowork: number;
  code: number;
};

type Segment = { mode: "chat" | "cowork" | "code"; percent: number };

function normalize({ chat, cowork, code }: ModeBarProps): Segment[] {
  const safeChat = Math.max(0, chat);
  const safeCowork = Math.max(0, cowork);
  const safeCode = Math.max(0, code);
  const total = safeChat + safeCowork + safeCode;
  if (total <= 0) {
    return [];
  }
  return [
    { mode: "chat" as const, percent: (safeChat / total) * 100 },
    { mode: "cowork" as const, percent: (safeCowork / total) * 100 },
    { mode: "code" as const, percent: (safeCode / total) * 100 },
  ].filter((segment) => segment.percent > 0);
}

function describe(segments: Segment[]): string {
  if (segments.length === 0) {
    return "no activity recorded";
  }
  return segments.map((segment) => `${Math.round(segment.percent)}% ${segment.mode}`).join(", ");
}

export function ModeBar(props: ModeBarProps) {
  const segments = useMemo(() => normalize(props), [props]);
  const label = describe(segments);
  if (segments.length === 0) {
    return <div className="mc-next-mode-bar mc-next-mode-bar-empty" role="img" aria-label={label} />;
  }
  return (
    <div className="mc-next-mode-bar" role="img" aria-label={label}>
      {segments.map((segment) => (
        <span
          key={segment.mode}
          className="mc-next-mode-bar-segment"
          data-mode={segment.mode}
          style={{ width: `${segment.percent}%` }}
        />
      ))}
    </div>
  );
}
