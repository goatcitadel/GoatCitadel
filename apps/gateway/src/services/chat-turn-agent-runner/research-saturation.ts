import type { ChatToolRunRecord, ChatWebMode } from "@goatcitadel/contracts";
import type { ChatExecutionBudget } from "../chat-agent-budget.js";
import { hostnameOf, openedHostname, WEB_RESEARCH_TOOL_NAMES } from "./deep-research-evidence.js";

export const RESEARCH_SATURATION_INSTRUCTION =
  "Your last two research steps found no new sites. Stop searching and write the answer from the evidence you have, noting any gaps.";

/** Consecutive research steps that must add no new site before the nudge is sent. */
const SATURATION_STALE_ITERATIONS = 2;

export interface ResearchSaturationState {
  /** Distinct sites search results had listed when the last step was recorded. */
  readonly knownListedCount: number;
  /** Distinct sites pages had been opened on when the last step was recorded. */
  readonly knownOpenedCount: number;
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

export interface ResearchHosts {
  /** Hosts listed by executed `browser.search` runs. */
  readonly listed: ReadonlySet<string>;
  /** Hosts executed page-opening runs landed on. */
  readonly opened: ReadonlySet<string>;
}

/**
 * The distinct sites a turn's research reached, kept apart: hosts listed by executed `browser.search`
 * runs and hosts executed page opens landed on, each compared without a leading `www.`. Opening a page
 * on an already listed site still grows the opened set. Failed, blocked, or approval-gated runs add nothing.
 */
export function collectResearchHosts(toolRuns: readonly ChatToolRunRecord[]): ResearchHosts {
  const listed = new Set<string>();
  const opened = new Set<string>();
  for (const run of toolRuns) {
    for (const hostname of searchResultHostnames(run)) {
      listed.add(hostname);
    }
    const openedHost = openedHostname(run);
    if (openedHost) {
      opened.add(openedHost);
    }
  }
  return { listed, opened };
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
  const { listed, opened } = collectResearchHosts(toolRuns);
  return { knownListedCount: listed.size, knownOpenedCount: opened.size, staleIterations: 0, nudged: false };
}

/**
 * Records one tool-loop step. A step that ran a web tool (any status) and neither listed a new site nor
 * opened a page on a new site extends the stale streak; any other step resets it. `nudge` is true once, on the step that completes two
 * stale steps in a row; later steps never nudge again in the same turn.
 */
export function recordResearchIteration(
  state: ResearchSaturationState,
  input: { toolRuns: readonly ChatToolRunRecord[]; iterationRuns: readonly ChatToolRunRecord[] },
): { state: ResearchSaturationState; nudge: boolean } {
  const { listed, opened } = collectResearchHosts(input.toolRuns);
  const ranWebTool = input.iterationRuns.some((run) => WEB_RESEARCH_TOOL_NAMES.has(run.toolName));
  const progressed = listed.size > state.knownListedCount || opened.size > state.knownOpenedCount;
  const stale = ranWebTool && !progressed;
  const staleIterations = stale ? state.staleIterations + 1 : 0;
  const nudge = !state.nudged && staleIterations >= SATURATION_STALE_ITERATIONS;
  return {
    state: {
      knownListedCount: Math.max(listed.size, state.knownListedCount),
      knownOpenedCount: Math.max(opened.size, state.knownOpenedCount),
      staleIterations,
      nudged: state.nudged || nudge,
    },
    nudge,
  };
}
