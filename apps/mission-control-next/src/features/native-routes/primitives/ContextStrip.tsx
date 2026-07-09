import type { ReactNode } from "react";

export type ContextStripMode = "chat" | "cowork" | "code";

export type ContextStripProps = {
  model: string;
  mode: ContextStripMode;
  memory?: string;
  cost?: string;
  tokens?: string;
  attachments?: ReactNode;
};

const MODE_LABEL: Record<ContextStripMode, string> = {
  chat: "Chat",
  cowork: "Chat",
  code: "Chat",
};

export function ContextStrip({ model, mode, memory, cost, tokens, attachments }: ContextStripProps) {
  const hasLive = Boolean(tokens) || Boolean(cost);
  return (
    <div className="mc-next-context-strip" data-mode={mode}>
      <span className="mc-next-context-strip-cell mc-next-context-strip-model">
        <span className="mc-next-context-strip-cell-label">Model</span>
        <span className="mc-next-context-strip-cell-value">{model}</span>
      </span>
      <span className="mc-next-context-strip-cell mc-next-context-strip-mode">
        <span className="mc-next-context-strip-cell-label">Mode</span>
        <span className="mc-next-context-strip-cell-value">{MODE_LABEL[mode]}</span>
      </span>
      {memory ? (
        <span className="mc-next-context-strip-cell mc-next-context-strip-memory">
          <span className="mc-next-context-strip-cell-label">Memory</span>
          <span className="mc-next-context-strip-cell-value">{memory}</span>
        </span>
      ) : null}
      {hasLive ? (
        <span className="mc-next-context-strip-cell mc-next-context-strip-live">
          <span className="mc-next-context-strip-cell-label">Live</span>
          <span className="mc-next-context-strip-cell-value">
            {tokens ? <span className="mc-next-context-strip-tokens">{tokens}</span> : null}
            {tokens && cost ? (
              <span className="mc-next-context-strip-sep" aria-hidden="true">
                ·
              </span>
            ) : null}
            {cost ? <span className="mc-next-context-strip-cost">{cost}</span> : null}
          </span>
        </span>
      ) : null}
      {attachments ? (
        <span className="mc-next-context-strip-cell mc-next-context-strip-attachments">{attachments}</span>
      ) : null}
    </div>
  );
}
