import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CitadelBrief } from "@goatcitadel/contracts";
import { fetchCitadelBrief } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getErrorMessage } from "../shared/native-helpers";
import { buildBriefMarkdown } from "./citadel-brief-format";

interface BriefState { key: string; loading: boolean; error: string | null; brief: CitadelBrief | null }
function hasBriefOwner(brief: CitadelBrief, citadelId: string) {
  return Boolean(brief && brief.citadelId === citadelId && typeof brief.generatedAt === "string" && typeof brief.since === "string"
    && Array.isArray(brief.workspaces) && Array.isArray(brief.approvals?.pending) && Number.isSafeInteger(brief.approvals.pendingCount)
    && brief.activity && Number.isSafeInteger(brief.activity.eventsSince) && Number.isSafeInteger(brief.activity.completedSince)
    && Number.isSafeInteger(brief.activity.failedSince) && Number.isSafeInteger(brief.activity.wardHitsSince)
    && brief.spend?.scope === "instance" && Number.isFinite(brief.spend.sinceUsd) && Number.isFinite(brief.spend.sinceTokens)
    && typeof brief.spend.complete === "boolean" && brief.memory && typeof brief.memory === "object"
    && ("unavailable" in brief.memory ? typeof brief.memory.unavailable === "string" : Number.isSafeInteger(brief.memory.pendingRecommendations))
    && brief.approvals.pending.every(item => typeof item.approvalId === "string" && typeof item.workspaceId === "string" && typeof item.kind === "string" && Number.isFinite(item.ageMs)));
}
export function useCitadelBrief(citadelId: string) {
  const installation = getGatewayApiBaseUrl(), key = JSON.stringify([installation, citadelId]);
  const [stored, setState] = useState<BriefState>({ key, loading: true, error: null, brief: null });
  const [copyNotice, setCopyNotice] = useState<{ tone: "success" | "warning"; message: string } | null>(null);
  const [copying, setCopying] = useState(false);
  const live = useRef({ key, mounted: true, read: 0, copy: 0 });
  const admitted = useRef(false);
  if (live.current.key !== key) { live.current.key = key; live.current.read += 1; live.current.copy += 1; admitted.current = false; }
  useLayoutEffect(() => {
    const owner = live.current; owner.mounted = true; setCopyNotice(null); setCopying(false);
    return () => { owner.mounted = false; owner.read += 1; owner.copy += 1; };
  }, [key]);
  const state: BriefState = stored.key === key ? stored : { key, loading: true, error: null, brief: null };
  const load = useCallback(async () => {
    const read = ++live.current.read;
    live.current.copy += 1; admitted.current = false; setCopying(false); setCopyNotice(null);
    const current = () => live.current.mounted && live.current.key === key && live.current.read === read && getGatewayApiBaseUrl() === installation;
    setState({ key, loading: true, error: null, brief: null });
    try {
      const brief = await fetchCitadelBrief(citadelId);
      if (!current()) return;
      if (!hasBriefOwner(brief, citadelId)) throw new Error("The brief owner returned different or unavailable Citadel evidence.");
      setState({ key, loading: false, error: null, brief });
    } catch (error) { if (current()) setState({ key, loading: false, error: getErrorMessage(error), brief: null }); }
  }, [citadelId, installation, key]);
  useEffect(() => { void load(); }, [load]);
  async function copy() {
    if (!state.brief || state.loading || state.error || admitted.current) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) { setCopyNotice({ tone: "warning", message: "Clipboard is unavailable in this browser." }); return; }
    const copyId = ++live.current.copy;
    const read = live.current.read;
    const current = () => live.current.mounted && live.current.key === key && live.current.copy === copyId && live.current.read === read && getGatewayApiBaseUrl() === installation;
    admitted.current = true; setCopying(true); setCopyNotice(null);
    try {
      await navigator.clipboard.writeText(buildBriefMarkdown(state.brief));
      if (current()) setCopyNotice({ tone: "success", message: "Brief copied as Markdown." });
    } catch (error) { if (current()) setCopyNotice({ tone: "warning", message: getErrorMessage(error) }); }
    finally { if (current()) { admitted.current = false; setCopying(false); } }
  }
  return { state, load, copy, copyNotice, copying };
}
