import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentProfileRecord, CitadelAccessSnapshot } from "@goatcitadel/contracts";
import {
  assignCitadelCouncilAgent,
  fetchAgents,
  unassignCitadelCouncilAgent,
} from "@goatcitadel/mission-control-shared/api/client";
import { useCitadelAccessReview } from "./useCitadelAccessReview";
import { sameBlueprintValue } from "./citadel-blueprint-binding";
import { getErrorMessage } from "../shared/native-helpers";

export interface CouncilReview {
  kind: "assign" | "remove";
  agentId: string;
  profile?: AgentProfileRecord;
  before: CitadelAccessSnapshot;
  generation: number;
}
interface Catalog {
  key: string;
  loading: boolean;
  error: string | null;
  agents: AgentProfileRecord[];
}
export function useCitadelCouncil(citadelId: string) {
  const access = useCitadelAccessReview(citadelId);
  const { key: ownerKey, isCurrent: ownerIsCurrent } = access;
  const live = useRef({ key: access.key, generation: 0, read: 0, mounted: true });
  if (live.current.key !== access.key) {
    live.current.key = access.key;
    live.current.generation += 1;
    live.current.read += 1;
  }
  const [stored, setCatalog] = useState<Catalog>({ key: access.key, loading: true, error: null, agents: [] });
  const catalog = stored.key === access.key ? stored : { key: access.key, loading: true, error: null, agents: [] };
  const [selectedAgentId, setSelectedAgent] = useState(""),
    [selectedSeatId, setStoredSeatId] = useState<string | null>(null);
  const [review, setReview] = useState<CouncilReview | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const reviewRef = useRef<CouncilReview | null>(null);
  const current = (generation: number) =>
    live.current.mounted &&
    access.isCurrent() &&
    live.current.key === access.key &&
    live.current.generation === generation;
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    reviewRef.current = null;
    setSelectedAgent("");
    setStoredSeatId(null);
    setReview(null);
    setNotice(null);
    return () => {
      owner.mounted = false;
      owner.generation += 1;
      owner.read += 1;
    };
  }, [access.key]);
  const readAgents = useCallback(async () => {
    const value = await fetchAgents("active", 300);
    if (
      !Array.isArray(value?.items) ||
      value.items.some(
        (item) =>
          !item ||
          typeof item.agentId !== "string" ||
          typeof item.name !== "string" ||
          item.lifecycleStatus !== "active",
      ) ||
      new Set(value.items.map((item) => item.agentId)).size !== value.items.length
    )
      throw new Error("The agent catalog returned an unavailable or contradictory profile list.");
    return value.items;
  }, []);
  const reloadAgents = useCallback(async () => {
    live.current.generation += 1;
    reviewRef.current = null;
    setReview(null);
    setNotice(null);
    const read = ++live.current.read,
      key = ownerKey;
    setCatalog({ key, loading: true, error: null, agents: [] });
    try {
      const agents = await readAgents();
      if (ownerIsCurrent() && live.current.read === read) setCatalog({ key, loading: false, error: null, agents });
    } catch (error) {
      if (ownerIsCurrent() && live.current.read === read)
        setCatalog({ key, loading: false, error: getErrorMessage(error), agents: [] });
    }
  }, [ownerKey, ownerIsCurrent, readAgents]);
  useEffect(() => {
    void reloadAgents();
  }, [reloadAgents]);
  const items = useMemo(() => access.snapshot?.council ?? [], [access.snapshot]);
  const seatedAgentIds = useMemo(() => new Set(items.map((item) => item.agentId)), [items]);
  useEffect(() => {
    setSelectedAgent((value) =>
      catalog.agents.some((agent) => agent.agentId === value) || items.some((seat) => seat.agentId === value)
        ? value
        : (catalog.agents.find((agent) => !seatedAgentIds.has(agent.agentId))?.agentId ?? ""),
    );
  }, [catalog.agents, items, seatedAgentIds]);
  function invalidate() {
    live.current.generation += 1;
    reviewRef.current = null;
    setReview(null);
    setNotice(null);
  }
  function setSelectedAgentId(value: string) {
    invalidate();
    setSelectedAgent(value);
  }
  function setSelectedSeatId(value: string | null) {
    invalidate();
    setStoredSeatId(value);
  }
  function request(kind: CouncilReview["kind"], agentId = selectedAgentId) {
    if (!access.ready || !access.snapshot || !agentId) return;
    const profile = catalog.agents.find((agent) => agent.agentId === agentId);
    if (kind === "assign" && (catalog.loading || catalog.error || !profile || seatedAgentIds.has(agentId))) return;
    if (kind === "remove" && !seatedAgentIds.has(agentId)) return;
    const value: CouncilReview = {
      kind,
      agentId,
      profile: profile ? structuredClone(profile) : undefined,
      before: structuredClone(access.snapshot),
      generation: live.current.generation,
    };
    reviewRef.current = value;
    setReview(value);
  }
  async function confirm() {
    const value = reviewRef.current;
    if (!value || !current(value.generation) || !access.ready) return;
    if (!sameBlueprintValue(value.before, access.snapshot)) {
      invalidate();
      setNotice("Access rules changed. Review the current owner before changing this Council seat.");
      return;
    }
    const saved = await access.run(
      value.before.revision,
      () =>
        value.kind === "assign"
          ? assignCitadelCouncilAgent(citadelId, value.agentId, value.before.revision)
          : unassignCitadelCouncilAgent(citadelId, value.agentId, value.before.revision),
      {
        change:
          value.kind === "assign"
            ? { type: "assign_agent", assignment: { agentId: value.agentId } }
            : { type: "unassign_agent", agentId: value.agentId },
        isReviewCurrent: () => reviewRef.current === value && current(value.generation),
        preflight:
          value.kind === "assign"
            ? async () => {
                const agents = await readAgents();
                if (!current(value.generation)) return false;
                const actual = agents.find((agent) => agent.agentId === value.agentId);
                if (sameBlueprintValue(actual, value.profile)) return true;
                setCatalog({ key: access.key, loading: false, error: null, agents });
                setNotice("The agent profile changed. Review the current catalog before seating it.");
                return false;
              }
            : undefined,
      },
    );
    if (!current(value.generation)) return;
    reviewRef.current = null;
    setReview(null);
    if (saved) {
      setNotice(value.kind === "assign" ? "Agent seated in this Citadel." : "Agent removed from this Citadel Council.");
      if (value.kind === "remove") setStoredSeatId(null);
    }
  }
  const selectedSeat = items.find((item) => item.assignmentId === selectedSeatId),
    selectedProfile = catalog.agents.find((agent) => agent.agentId === selectedSeat?.agentId);
  return {
    access,
    council: { ...catalog, items },
    selectedAgentId,
    setSelectedAgentId,
    selectedSeat,
    selectedProfile,
    setSelectedSeatId,
    seatedAgentIds,
    review,
    notice,
    request,
    confirm,
    cancel: invalidate,
    reloadAgents,
  };
}
