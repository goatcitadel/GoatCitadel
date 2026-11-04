import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CapabilityPluginDetail, ChangePlanRecord, PluginActionOutcome } from "@goatcitadel/contracts";
import { uninstallCapabilityPlugin } from "@goatcitadel/mission-control-shared/api/capability-plugins";
import { fetchChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { pluginDetailQuery } from "../../../data/capability-plugins-query";
import { PLUGIN_PLAN_KEYS } from "../../../data/event-map";
import { queryKeys } from "../../../data/query-keys";
import { DONE, ENDED } from "../change-plan-outcome";
import { refusalMessage, wasAnswered } from "./plugin-check-copy";
import { focusPluginsList, PLUGINS_HREF } from "./plugin-links";
import { pluginInstallKey } from "./plugin-install-store";
import {
  pluginUninstallCustody,
  readPluginUninstall,
  setPluginUninstall,
  usePluginUninstallEntry,
  type PluginUninstallEntry,
} from "./plugin-uninstall-store";
import { uninstallApproval, uninstallProgressLine } from "./plugin-uninstall-view";
import { resetPluginInstall } from "./use-plugin-install";

// Following an uninstall: GoatCitadel's answer, then the plugin's detail until it says the plugin isn't installed. The
// Gateway decides what goes and what stays; nothing here starts a plan the operator didn't press for.

/** Waits between reads while something is removed: a second for the first 30, then 3 seconds. */
const APPLYING_MS = 1_000;
const APPLYING_FAST_WAITS = 30;
const APPLYING_SLOW_MS = 3_000;
/** Waits between reads while an approval waits: 5 seconds at first, then less often, at most every 30. */
const WAITING_MS = [5_000, 5_000, 5_000, 10_000, 20_000, 30_000] as const;

const LOST = "The request got no answer. Try again.";
const NOT_UNINSTALLED = "Not uninstalled.";

/** Every list a plugin's pieces show in, refreshed after each step: no event says an uninstall moved. */
function refreshAfterStep(client: QueryClient) {
  for (const queryKey of PLUGIN_PLAN_KEYS) void client.invalidateQueries({ queryKey });
}

/** The outcome GoatCitadel gave, as the entry follows it. */
function followOutcome(workspaceId: string, outcome: PluginActionOutcome) {
  if (outcome.outcome === "failed") {
    // Said once, as the stop it is, never as a quiet summary beside it.
    return { phase: "stopped" as const, workspaceId, message: outcome.summary };
  }
  return {
    phase: "following" as const,
    workspaceId,
    planId: outcome.planId,
    summary: outcome.summary,
    ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
  };
}

/** Asks for the uninstall, or for its next pass. One attempt key per press, reused only when no answer came. */
async function requestUninstall(detail: CapabilityPluginDetail, client: QueryClient) {
  const { pluginId, workspaceId } = detail;
  const before = readPluginUninstall(pluginId);
  if (before?.phase === "asking") return;
  const attemptKey = before?.lost && before.attemptKey ? before.attemptKey : crypto.randomUUID();
  const custody = pluginUninstallCustody();
  const pending = { phase: "asking", workspaceId, attemptKey } as const;
  const current = () => custody === pluginUninstallCustody() && readPluginUninstall(pluginId) === pending;
  setPluginUninstall(pluginId, pending);
  if (!current()) return;
  try {
    const outcome = await uninstallCapabilityPlugin({ workspaceId, pluginId }, { attemptKey });
    if (!current()) return;
    setPluginUninstall(pluginId, followOutcome(workspaceId, outcome));
  } catch (error) {
    if (!current()) return;
    const lost = !wasAnswered(error);
    setPluginUninstall(pluginId, {
      phase: "stopped",
      workspaceId,
      message: lost ? LOST : refusalMessage(error),
      ...(lost ? { lost, attemptKey } : {}),
    });
  }
  if (custody === pluginUninstallCustody()) refreshAfterStep(client);
}

/**
 * How the detail is read now: at the applying pace while the plan applies or a piece is being removed, at the waiting
 * pace while an approval waits, and not at all once the first pass is over and the next move ("Finish uninstalling")
 * is the operator's.
 */
type Pace = "applying" | "waiting" | "operator";

function paceOf(detail: CapabilityPluginDetail | undefined, waitingOnApproval: boolean): Pace {
  if (waitingOnApproval) return "waiting";
  if (detail?.state !== "uninstalling") return "applying";
  return detail.pieces.some((piece) => piece.state === "removing") ? "applying" : "operator";
}

function nextReadMs(count: number, pace: Pace): number | false {
  if (pace === "operator") return false;
  if (pace === "waiting") return WAITING_MS[Math.min(count, WAITING_MS.length) - 1] ?? WAITING_MS[0];
  return count <= APPLYING_FAST_WAITS ? APPLYING_MS : APPLYING_SLOW_MS;
}

const planQueryKey = (planId: string | undefined, custody: number) =>
  ["change-plan", "plugin-uninstall", planId, custody] as const;

/** Why a plan ended without uninstalling: a decline or an expiry in plain words, else GoatCitadel's own summary. */
function endedLine(plan: ChangePlanRecord): string {
  const code = plan.result?.failureCode;
  if (code === "approval_denied") return `${NOT_UNINSTALLED} The request was declined.`;
  if (code === "approval_expired" || code === "expired") return `${NOT_UNINSTALLED} The request expired.`;
  return plan.result?.summary?.trim() || NOT_UNINSTALLED;
}

/**
 * The plan of the last request, read until it ends, on either pass: one that ends without uninstalling (declined,
 * expired or failed) stops the flow with its reason. A plan that completed leaves the detail to say what's left.
 */
function useEndedPlan(pluginId: string, entry: PluginUninstallEntry | undefined, custody: number) {
  const planId = entry?.phase === "following" ? entry.planId : undefined;
  const current = () => custody === pluginUninstallCustody() && readPluginUninstall(pluginId) === entry;
  const plan = useQuery({
    queryKey: planQueryKey(planId, custody),
    queryFn: () => {
      if (!current()) throw new Error("Plugin uninstall custody changed.");
      return fetchChangePlan(planId ?? "", { workspaceId: entry?.workspaceId ?? "default" });
    },
    enabled: () => planId !== undefined && current(),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return !current() || (status && (DONE.has(status) || ENDED.has(status))) ? false : 10_000;
    },
  });
  useEffect(() => {
    const status = plan.data?.status;
    if (custody !== pluginUninstallCustody()) return;
    if (!planId || !plan.data || !status || DONE.has(status) || !ENDED.has(status)) return;
    const current = readPluginUninstall(pluginId);
    if (current?.phase !== "following" || current !== entry) return;
    setPluginUninstall(pluginId, { ...current, phase: "stopped", message: endedLine(plan.data) });
  }, [plan.data, planId, pluginId, entry, custody]);
}

/**
 * Once the detail says the plugin isn't installed: the lists are refreshed, the session forgets the uninstall and the
 * plugin's last detail (a reinstall reads the live plugin), the panel closes and focus goes back to the plugins list.
 */
function useGone(gone: boolean, pluginId: string, entry: PluginUninstallEntry | undefined, custody: number) {
  const client = useQueryClient();
  const { navigate } = useCockpitRoute();
  useEffect(() => {
    if (!gone || custody !== pluginUninstallCustody() || readPluginUninstall(pluginId) !== entry) return;
    setPluginUninstall(pluginId, undefined);
    resetPluginInstall(pluginInstallKey(pluginId));
    refreshAfterStep(client);
    navigate(PLUGINS_HREF, { replace: true });
    client.removeQueries({ queryKey: queryKeys.capabilityPluginDetail(entry?.workspaceId ?? "default", pluginId) });
    focusPluginsList();
  }, [gone, pluginId, entry, custody, client, navigate]);
}

/**
 * One plugin's uninstall: the request, the approval it waits on in place, and the detail it follows until the plugin is
 * gone. "Finish uninstalling" asks for the next pass while the plugin still reads as uninstalling; it is safe to press
 * early, since GoatCitadel goes on from where it stopped.
 */
export function usePluginUninstall(detail: CapabilityPluginDetail | undefined, pluginId: string) {
  const client = useQueryClient();
  const [custody] = useState(pluginUninstallCustody);
  const observed = usePluginUninstallEntry(pluginId);
  const entry = custody === pluginUninstallCustody() ? observed : undefined;
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());
  const reads = useRef(0);
  const pace = useRef<Pace>("applying");
  const following = entry?.phase === "following";
  const workspaceId = entry?.workspaceId ?? detail?.workspaceId;
  const read = useQuery({
    ...pluginDetailQuery(workspaceId ?? "default", pluginId),
    enabled: () => custody === pluginUninstallCustody() && following && workspaceId !== undefined,
    refetchInterval: () =>
      custody === pluginUninstallCustody() && following ? nextReadMs((reads.current += 1), pace.current) : false,
  });
  const latest = read.data ?? detail;
  const approval = uninstallApproval(entry, latest, decided);
  pace.current = paceOf(latest, approval !== undefined);
  useEndedPlan(pluginId, entry, custody);
  useGone(
    following && read.isError && isApiRequestError(read.error) && read.error.status === 404,
    pluginId,
    entry,
    custody,
  );
  return {
    entry,
    detail: latest,
    approval,
    progress: uninstallProgressLine(entry, latest, approval),
    start: () => {
      if (!latest || custody !== pluginUninstallCustody()) return;
      reads.current = 0;
      void requestUninstall(latest, client);
    },
    resolved: (approvalId: string) => {
      if (custody !== pluginUninstallCustody() || readPluginUninstall(pluginId) !== entry) return;
      setDecided((all) => new Set([...all, approvalId]));
      reads.current = 0;
      refreshAfterStep(client);
      void client.invalidateQueries({ queryKey: planQueryKey(entry?.planId, custody) });
    },
  };
}
