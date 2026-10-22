import type { ChatToolRunRecord, ChatWebMode } from "@goatcitadel/contracts";
import type { ChatExecutionBudget } from "../chat-agent-budget.js";
import { hostnameOf, openedHostname, WEB_RESEARCH_TOOL_NAMES } from "./deep-research-evidence.js";

export const RESEARCH_SATURATION_INSTRUCTION =
  "Your last two research steps found no new sites. Stop searching and write the answer from the evidence you have, noting any gaps.";

/** Consecutive research steps that must add no new site before the nudge is sent. */
const SATURATION_STALE_ITERATIONS = 2;

export interface ResearchSaturationState {
  /** Distinct sites the turn's research had reached when the last step was recorded. */
  readonly knownHostCount: number;
  /** Consecutive steps that ran a web tool and reached no new site. */
  readonly staleIterations: number;
  /** The nudge was already sent this turn. */
  readonly nudged: boolean;
}

function searchResultHostnames(run: ChatToolRunRecord): string[] {
  if (run.status !== "executed" || run.toolName !== "browser.search") {
    return [];
  }
  const results = run.result?.results;
  if (!Array.isArray(results)) {
    return [];
  }
  const hostnames: string[] = [];
  for (const entry of results) {
    const url = entry && typeof entry === "object" ? (entry as { url?: unknown }).url : undefined;
    const hostname = typeof url === "string" ? hostnameOf(url) : undefined;
    if (hostname) {
      hostnames.push(hostname);
    }
  }
  return hostnames;
}

/**
 * The distinct sites a turn's research reached: hosts listed by executed `browser.search` runs plus
 * the hosts executed page opens landed on, compared without a leading `www.`. Failed, blocked, or
 * approval-gated runs add nothing.
 */
export function collectResearchHosts(toolRuns: readonly ChatToolRunRecord[]): Set<string> {
  const hosts = new Set<string>();
  for (const run of toolRuns) {
    for (const hostname of searchResultHostnames(run)) {
      hosts.add(hostname);
    }
    const opened = openedHostname(run);
    if (opened) {
      hosts.add(opened);
    }
  }
  return hosts;
}

/** The nudge applies to Deep mode and research-list turns, never to a Prompt Lab eval-integrity turn. */
export function isResearchSaturationTurn(input: {
  webMode: ChatWebMode;
  budgetProfile: ChatExecutionBudget["profile"];
  promptLabEvalIntegrity: boolean;
}): boolean {
  if (input.promptLabEvalIntegrity) {
    return false;
  }
  return input.webMode === "deep" || input.budgetProfile === "research_list";
}

/** The starting state, with the sites reached before the tool loop (such as a seed search) as the baseline. */
export function startResearchSaturation(toolRuns: readonly ChatToolRunRecord[]): ResearchSaturationState {
  return { knownHostCount: collectResearchHosts(toolRuns).size, staleIterations: 0, nudged: false };
}

/**
 * Records one tool-loop step. A step that ran a web tool (any status) and reached no new site extends
 * the stale streak; any other step resets it. `nudge` is true once, on the step that completes two
 * stale steps in a row; later steps never nudge again in the same turn.
 */
export function recordResearchIteration(
  state: ResearchSaturationState,
  input: { toolRuns: readonly ChatToolRunRecord[]; iterationRuns: readonly ChatToolRunRecord[] },
): { state: ResearchSaturationState; nudge: boolean } {
  const hostCount = collectResearchHosts(input.toolRuns).size;
  const ranWebTool = input.iterationRuns.some((run) => WEB_RESEARCH_TOOL_NAMES.has(run.toolName));
  const stale = ranWebTool && hostCount <= state.knownHostCount;
  const staleIterations = stale ? state.staleIterations + 1 : 0;
  const nudge = !state.nudged && staleIterations >= SATURATION_STALE_ITERATIONS;
  return {
    state: {
      knownHostCount: Math.max(hostCount, state.knownHostCount),
      staleIterations,
      nudged: state.nudged || nudge,
    },
    nudge,
  };
}
