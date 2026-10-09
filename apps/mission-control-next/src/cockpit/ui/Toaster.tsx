import { Toaster } from "sonner";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

export function CockpitToaster() {
  const { theme } = useUiPreferences();
  return <Toaster position="top-right" offset={16} visibleToasts={3} expand theme={theme} closeButton />;
}
