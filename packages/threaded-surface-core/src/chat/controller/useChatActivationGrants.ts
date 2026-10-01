import type { AutonomousActivationGrantRecord } from "@goatcitadel/contracts";
import { fetchAutonomousActivationGrants } from "@goatcitadel/mission-control-shared/api/client";
import { useEffect, useState } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";

type Input = {
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
};

/** Loads advisory activation grant evidence without changing policy authority. */
export function useChatActivationGrants({ workspaceId }: Input) {
  const [autonomousActivationGrants, setAutonomousActivationGrants] = useState<AutonomousActivationGrantRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refreshAutonomousActivationGrants = () => {
      void fetchAutonomousActivationGrants(true)
        .then((response) => {
          if (!cancelled) setAutonomousActivationGrants(response.items ?? []);
        })
        .catch(() => {
          if (!cancelled) setAutonomousActivationGrants([]);
        });
    };
    refreshAutonomousActivationGrants();
    if (typeof window !== "undefined") {
      window.addEventListener("goatcitadel:autonomous-activation-grants-changed", refreshAutonomousActivationGrants);
    }
    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener(
          "goatcitadel:autonomous-activation-grants-changed",
          refreshAutonomousActivationGrants,
        );
      }
    };
  }, [workspaceId]);

  return { autonomousActivationGrants };
}
