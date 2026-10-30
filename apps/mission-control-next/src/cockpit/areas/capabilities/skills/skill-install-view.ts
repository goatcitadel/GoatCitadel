import type { CapabilitySkillInstall, CapabilitySkillInstallAsks } from "@goatcitadel/contracts";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { toolLabel } from "../tools/tool-labels";
import { joinLabels } from "./discover-view";
import type { SkillInstallState, SkillInstallStepKind } from "./skill-install-store";

// Wording for the install panel. Every step, blocker and request comes from the Gateway; nothing here decides whether
// a skill can be installed or what comes next, it only says what the Gateway's step means.

export const NOTHING_ASKED = "Nothing beyond its instructions";
export const SCRIPTS_LINE = "Includes scripts. Installing it doesn't run them.";
export const INSTALLED_NOT_ON = "Installed, not switched on";
export const SKIP_ON_NEXT =
  "Installs and switches on at once, because your setting to skip approvals for your own changes is on.";
export const SKIP_OFF_NEXT = "Asks you twice: once to install it and once to switch it on.";

/** The capability id prefix the check's tool list carries; the tool labels are keyed by the bare name. */
const TOOL_PREFIX = /^tool:/u;

/**
 * What the skill asks for, one line each, only the lines that apply: each tool by its label (once, however many ids
 * share it), the hosts it reaches, the settings it reads, the files it reads and writes, the programs it needs and
 * whether it includes scripts. A skill that asks for none of these says so.
 */
export function asksForLines(asks: CapabilitySkillInstallAsks): string[] {
  const lines = [...new Set(asks.tools.map((id) => toolLabel(id.replace(TOOL_PREFIX, ""))))];
  if (asks.networkHosts.length > 0) lines.push(`Reaches ${joinLabels(asks.networkHosts)}`);
  if (asks.envVars.length > 0) lines.push(`Needs settings: ${asks.envVars.join(", ")}`);
  if (asks.readsFiles.length > 0) lines.push(`Reads ${joinLabels(asks.readsFiles)}`);
  if (asks.writesFiles.length > 0) lines.push(`Writes ${joinLabels(asks.writesFiles)}`);
  if (asks.requires.length > 0) lines.push(`Needs ${joinLabels(asks.requires)}`);
  if (asks.includesScripts) lines.push(SCRIPTS_LINE);
  return lines.length > 0 ? lines : [NOTHING_ASKED];
}

/** One row of the step list: the step's name and where it stands. */
export interface InstallStepRow {
  name: "Check" | "Install" | "Switch on";
  status: StatusPresentation;
}

const NOT_STARTED: StatusPresentation = { label: "Not started", tone: "neutral" };
const ASKING: StatusPresentation = { label: "Asking…", tone: "running" };
const WAITING: StatusPresentation = { label: "Waiting for your approval", tone: "waiting" };
const DONE: StatusPresentation = { label: "Done", tone: "done" };
const DIDNT_FINISH: StatusPresentation = { label: "Didn't finish", tone: "failed" };

/** What the panel knows about its flow, for the step list. */
export interface InstallFlowView {
  state: SkillInstallState;
  asked?: SkillInstallStepKind;
  asking: boolean;
  chain: boolean;
}

function installStatus(install: CapabilitySkillInstall, flow: InstallFlowView): StatusPresentation {
  switch (install.step) {
    case "check_passed":
      return flow.asking ? ASKING : NOT_STARTED;
    case "blocked":
      return NOT_STARTED;
    case "waiting_install":
      return WAITING;
    case "installing":
      return { label: "Installing…", tone: "running" };
    case "failed":
      return flow.asked === "activate" ? DONE : DIDNT_FINISH;
    default:
      return DONE;
  }
}

function switchOnStatus(install: CapabilitySkillInstall, flow: InstallFlowView): StatusPresentation {
  switch (install.step) {
    case "installed_off":
      // Installed by this confirmation, which asks to switch it on next without another press.
      return flow.asking || flow.chain ? ASKING : NOT_STARTED;
    case "waiting_switch_on":
      return WAITING;
    case "switching_on":
      return { label: "Switching on…", tone: "running" };
    case "done":
      return DONE;
    case "failed":
      return flow.asked === "activate" ? DIDNT_FINISH : NOT_STARTED;
    default:
      return NOT_STARTED;
  }
}

/**
 * The step list: Check, Install and Switch on with where each stands. Empty for a stop whose step isn't known here
 * (an install found stopped after a reload): the panel says why it stopped instead.
 */
export function installSteps(flow: InstallFlowView): InstallStepRow[] {
  const { state } = flow;
  if (state.phase === "checking")
    return [
      { name: "Check", status: { label: "Checking…", tone: "running" } },
      { name: "Install", status: NOT_STARTED },
      { name: "Switch on", status: NOT_STARTED },
    ];
  if (state.phase === "done")
    return [
      { name: "Check", status: { label: "Passed", tone: "done" } },
      { name: "Install", status: DONE },
      { name: "Switch on", status: DONE },
    ];
  const install = "install" in state ? state.install : undefined;
  if (!install || (state.phase === "failed" && !flow.asked)) return [];
  return [
    {
      name: "Check",
      status: install.step === "blocked" ? { label: "Didn't pass", tone: "failed" } : { label: "Passed", tone: "done" },
    },
    { name: "Install", status: installStatus(install, flow) },
    { name: "Switch on", status: switchOnStatus(install, flow) },
  ];
}

/** The one line the panel reads out as the install moves, or empty when nothing is under way. */
export function progressLine(flow: InstallFlowView, name: string): string {
  const { state } = flow;
  if (state.phase === "checking") return "Checking it…";
  if (state.phase === "done") return `${name} is installed and switched on.`;
  if (state.phase !== "following" && !(state.phase === "ready" && flow.asking)) return "";
  const step = state.install.step;
  if (flow.asking || (step === "installed_off" && flow.chain)) return "Asking…";
  if (step === "waiting_install") return "Waiting for your approval to install it.";
  if (step === "installing") return "Installing…";
  if (step === "waiting_switch_on") return "Waiting for your approval to switch it on.";
  if (step === "switching_on") return "Switching on…";
  return "";
}

/** The approval dialog's words for each step. */
export function approvalWords(step: "waiting_install" | "waiting_switch_on", name: string) {
  return step === "waiting_install"
    ? {
        title: `Approve installing ${name}?`,
        summary: `Installs ${name} switched off. It can't be used until you switch it on.`,
      }
    : { title: `Approve switching on ${name}?`, summary: `Lets the AI use ${name} in new chats.` };
}
