import { ContextStrip } from "@goatcitadel/mission-control-next";

export const Chat = () => <ContextStrip model="Claude Opus 4.8" mode="chat" tokens="12.4k tokens" cost="$0.18" />;

export const Cowork = () => (
  <ContextStrip model="Claude Sonnet 4.6" mode="cowork" memory="project: citadel" tokens="48.1k" cost="$0.62" />
);

export const Code = () => <ContextStrip model="Claude Haiku 4.5" mode="code" tokens="3.2k" />;
