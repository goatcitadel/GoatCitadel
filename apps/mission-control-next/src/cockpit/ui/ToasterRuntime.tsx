import { useEffect } from "react";
import { Toaster, toast } from "sonner";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { attachCockpitToastHost } from "./toast-runtime";
export function CockpitToastRuntime() {
  const { theme } = useUiPreferences();
  useEffect(() => attachCockpitToastHost(toast), []);
  // Below the 48px area and inspector header rows, so a persistent error toast never covers their actions.
  return (
    <Toaster
      position="top-right"
      offset={{ top: 64, right: 16 }}
      mobileOffset={{ top: 64, right: 12, left: 12 }}
      visibleToasts={3}
      expand
      theme={theme}
      closeButton
    />
  );
}
