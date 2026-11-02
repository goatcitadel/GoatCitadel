import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CapabilityPluginDetail, PluginActionOutcome } from "@goatcitadel/contracts";
import { uninstallCapabilityPlugin } from "@goatcitadel/mission-control-shared/api/capability-plugins";
import { fetchChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { pluginDetailQuery } from "../../../data/capability-plugins-query";
import { PLUGIN_PLAN_KEYS } from "../../../data/event-map";
import { DONE, ENDED } from "../change-plan-outcome";
import { refusalMessage, wasAnswered } from "./plugin-check-copy";
import { focusPluginsList, PLUGINS_HREF } from "./plugin-links";
import { pluginInstallKey } from "./plugin-install-store";
import { readPluginUninstall, setPluginUninstall, usePluginUninstallEntry } from "./plugin-uninstall-store";
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
    return { phase: "stopped" as const, workspaceId, message: outcome.summary, summary: outcome.summary };
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
  setPluginUninstall(pluginId, { phase: "asking", workspaceId, attemptKey });
  try {
    const outcome = await uninstallCapabilityPlugin({ workspaceId, pluginId }, { attemptKey });
    setPluginUninstall(pluginId, followOutcome(workspaceId, outcome));
  } catch (error) {
    const lost = !wasAnswered(error);
    setPluginUninstall(pluginId, {
      phase: "stopped",
      workspaceId,
      message: lost ? LOST : refusalMessage(error),
      ...(lost ? { lost, attemptKey } : {}),
    });
  }
  refreshAfterStep(client);
}

/** How long to wait before the next read: the waiting pace while an approval waits, else the applying pace. */
function nextReadMs(count: number, waiting: boolean): number {
  if (waiting) return WAITING_MS[Math.min(count, WAITING_MS.length) - 1] ?? WAITING_MS[0];
  return count <= APPLYING_FAST_WAITS ? APPLYING_MS : APPLYING_SLOW_MS;
}

/** The plan's end, when it ended without uninstalling: a decline, an expiry or a failure, in GoatCitadel's words. */
function useEndedPlan(pluginId: string, detail: CapabilityPluginDetail | undefined) {
  const entry = usePluginUninstallEntry(pluginId);
  const planId = entry?.phase === "following" && detail?.state !== "uninstalling" ? entry.planId : undefined;
  const plan = useQuery({
    queryKey: ["change-plan", "plugin-uninstall", planId],
    queryFn: () => fetchChangePlan(planId ?? "", { workspaceId: entry?.workspaceId ?? "default" }),
    enabled: planId !== undefined,
    refetchInterval: 5_000,
  });
  useEffect(() => {
    const status = plan.data?.status;
    if (!planId || !status || DONE.has(status) || !ENDED.has(status)) return;
    const current = readPluginUninstall(pluginId);
    if (current?.phase !== "following" || current.planId !== planId) return;
    const summary = plan.data?.result?.summary?.trim();
    setPluginUninstall(pluginId, { ...current, phase: "stopped", message: summary || NOT_UNINSTALLED });
  }, [plan.data, planId, pluginId]);
}

/**
 * One plugin's uninstall: the request, the approval it waits on in place, and the detail it follows until the plugin is
 * gone, when the lists are refreshed, the panel closes and focus goes back to the plugins list. "Finish uninstalling"
 * asks for the next pass while the plugin still reads as uninstalling; it is safe to press early, since GoatCitadel
 * goes on from where it stopped.
 */
export function usePluginUninstall(detail: CapabilityPluginDetail | undefined, pluginId: string) {
  const client = useQueryClient();
  const { navigate } = useCockpitRoute();
  const entry = usePluginUninstallEntry(pluginId);
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());
  const reads = useRef(0);
  // While nothing is being removed (an approval waits, or the plan hasn't begun), reads slow to the waiting pace.
  const waiting = useRef(false);
  const following = entry?.phase === "following";
  const workspaceId = entry?.workspaceId ?? detail?.workspaceId;
  const read = useQuery({
    ...pluginDetailQuery(workspaceId ?? "default", pluginId),
    enabled: following && workspaceId !== undefined,
    refetchInterval: following ? () => nextReadMs((reads.current += 1), waiting.current) : false,
  });
  const latest = read.data ?? detail;
  const approval = uninstallApproval(entry, latest, decided);
  waiting.current = approval !== undefined || latest?.state !== "uninstalling";
  useEndedPlan(pluginId, latest);
  const gone = following && read.isError && isApiRequestError(read.error) && read.error.status === 404;

  useEffect(() => {
    if (!gone) return;
    setPluginUninstall(pluginId, { phase: "gone", workspaceId: workspaceId ?? "default" });
    resetPluginInstall(pluginInstallKey(pluginId));
    refreshAfterStep(client);
    // The panel is about a plugin that no longer exists: close it, and give focus back to the list.
    navigate(PLUGINS_HREF, { replace: true });
    focusPluginsList();
  }, [gone, pluginId, workspaceId, client, navigate]);

  const start = () => {
    if (!latest) return;
    reads.current = 0;
    void requestUninstall(latest, client);
  };
  return {
    entry,
    detail: latest,
    approval,
    progress: uninstallProgressLine(entry, latest, approval),
    start,
    resolved: (approvalId: string) => {
      setDecided((all) => new Set([...all, approvalId]));
      reads.current = 0;
      refreshAfterStep(client);
    },
  };
}
