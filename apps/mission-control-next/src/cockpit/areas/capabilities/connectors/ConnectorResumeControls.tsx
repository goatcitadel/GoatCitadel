import { useState } from "react";
import type { CapabilityConnectorItem, CapabilityConnectorState } from "@goatcitadel/contracts";
import { ConnectorInstallProgress, InstallStatus, type InstallStepId } from "./ConnectorInstallProgress";
import { IDLE as SILENT } from "./connector-install-store";
import { useConnectorInstall } from "./use-connector-install";

type ResumeFrom = "sign_in" | "connect";

/** The button a saved server's state calls for, and where its flow starts (R72). Other states have none. */
const RESUME: Readonly<Partial<Record<CapabilityConnectorState, { label: string; from: ResumeFrom }>>> = {
  needs_sign_in: { label: "Connect", from: "sign_in" },
  sign_in_expired: { label: "Reconnect", from: "sign_in" },
  broken: { label: "Try again", from: "connect" },
};

const STEPS: Readonly<Record<ResumeFrom, readonly InstallStepId[]>> = {
  sign_in: ["sign_in", "switch_on", "connect"],
  connect: ["connect"],
};

/**
 * A saved MCP server's sign-in or connect, run from its panel: Connect or Reconnect signs in, then switches it on and
 * connects; Try again connects. The progress is the install panel's, and an install that saved this server shows its
 * result here too. `announce` is off while the panel around it reads the same flow out itself.
 */
export function ConnectorResumeControls({
  item,
  announce = true,
}: {
  item: CapabilityConnectorItem;
  announce?: boolean;
}) {
  const install = useConnectorInstall(item);
  const resume = RESUME[item.state];
  // The steps of the last button pressed here; before that, of the button the state offers.
  const [from, setFrom] = useState<ResumeFrom>(resume?.from ?? "sign_in");
  // A finished flow has nothing more to say here: the state above already reads Connected.
  const shown = resume !== undefined || (install.state.phase !== "idle" && install.state.phase !== "done");
  return (
    <>
      {shown ? (
        <ConnectorInstallProgress
          install={install}
          scope={item.id}
          steps={STEPS[from]}
          action={
            resume
              ? {
                  label: resume.label,
                  run: () => {
                    setFrom(resume.from);
                    install.resume(resume.from);
                  },
                }
              : undefined
          }
        />
      ) : null}
      {/* Kept on the page while silenced, so it reads out the next change once it may speak again. */}
      <InstallStatus state={announce ? install.state : SILENT} doneWords="Connected." />
    </>
  );
}
