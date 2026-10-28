import { useRef, useState } from "react";
import type { CapabilityConnectorItem, CapabilityConnectorState } from "@goatcitadel/contracts";
import { ConnectorInstallProgress, installSteps, InstallStatus, type InstallStepId } from "./ConnectorInstallProgress";
import { IDLE as SILENT, type ConnectorInstallState } from "./connector-install-store";
import { connectedAnnouncement } from "./connector-view";
import { useConnectorInstall } from "./use-connector-install";
import { usePanelFocus } from "./use-panel-focus";

type ResumeFrom = "sign_in" | "connect";

/** The button a saved server's state calls for, and where its flow starts (R72). Other states have none. */
const RESUME: Readonly<Partial<Record<CapabilityConnectorState, { label: string; from: ResumeFrom }>>> = {
  needs_sign_in: { label: "Connect", from: "sign_in" },
  sign_in_expired: { label: "Reconnect", from: "sign_in" },
  broken: { label: "Try again", from: "connect" },
};

/**
 * After a sign-in that failed, a server whose state offers no button (one its install left switched off) still gets
 * one: the failure says to sign in again (I1). A vendor that refused to register GoatCitadel would refuse that too, so
 * that failure only links to Settings.
 */
const SIGN_IN_AGAIN = { label: "Sign in again", from: "sign_in" } as const;
const signInFailed = (state: ConnectorInstallState) =>
  state.phase === "failed" && (state.step === "sign_in" || state.step === "finish_sign_in") && !state.signInBlocked;

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
  const anchor = useRef<HTMLParagraphElement>(null);
  usePanelFocus(anchor, "primary");
  // While a registration refusal is shown, a button that signs in again would only be refused the same way.
  const blocked = install.state.phase === "failed" && install.state.signInBlocked === true;
  const stateButton = RESUME[item.state];
  const own = blocked && stateButton?.from === "sign_in" ? undefined : stateButton;
  const resume = own ?? (signInFailed(install.state) ? SIGN_IN_AGAIN : undefined);
  // The button last pressed here says which steps its flow runs. A flow this view didn't start, with no button of the
  // state's own to offer, is the install that saved this server, so it lists the install's own steps.
  const [pressed, setPressed] = useState<ResumeFrom | undefined>(undefined);
  const steps = pressed ? STEPS[pressed] : stateButton ? STEPS[stateButton.from] : installSteps(item);
  // A finished flow has nothing more to say here: the state above already reads Connected.
  const shown = resume !== undefined || (install.state.phase !== "idle" && install.state.phase !== "done");
  return (
    <>
      {shown ? (
        <ConnectorInstallProgress
          install={install}
          scope={item.id}
          steps={steps}
          action={
            resume
              ? {
                  label: resume.label,
                  run: () => {
                    setPressed(resume.from);
                    install.resume(resume.from);
                  },
                }
              : undefined
          }
        />
      ) : null}
      {/* Kept on the page while silenced, so it reads out the next change once it may speak again. */}
      <InstallStatus
        anchor={anchor}
        state={announce ? install.state : SILENT}
        doneWords={connectedAnnouncement(item)}
      />
    </>
  );
}
