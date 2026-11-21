import type { ChatWebMode } from "@goatcitadel/contracts";

/** Quick is no longer offered: it only shrank the search budget and never forced a search, so it read as Auto. */
export const WEB_MODES: readonly { value: ChatWebMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "deep", label: "Deep" },
];
