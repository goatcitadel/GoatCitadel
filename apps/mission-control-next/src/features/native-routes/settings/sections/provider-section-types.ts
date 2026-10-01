import type { Dispatch, SetStateAction } from "react";
import type { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type { Notice } from "../SettingsShared";

export type ProviderCatalog = ReturnType<typeof useProviderModelCatalog>;
export type ProviderNoticeSetter = Dispatch<SetStateAction<Notice | null>>;
export interface ProviderEditorIdentity {
  key: string;
  providerId: string;
  view: string | null;
}
