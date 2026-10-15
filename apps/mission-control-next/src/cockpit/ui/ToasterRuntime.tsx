import { useEffect } from "react";
import { Toaster, toast } from "sonner";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { attachCockpitToastHost } from "./toast-runtime";
export function CockpitToastRuntime() {
  const { theme } = useUiPreferences();
  useEffect(() => attachCockpitToastHost(toast), []);
  return <Toaster position="top-right" offset={16} visibleToasts={3} expand theme={theme} closeButton />;
}
