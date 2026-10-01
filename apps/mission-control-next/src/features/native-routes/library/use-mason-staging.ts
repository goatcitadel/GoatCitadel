import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CitadelStructureSnapshot } from "@goatcitadel/contracts";
import {
  getCitadelStructureSnapshot,
  getMasonSession,
  stageMasonBlueprint,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  blueprintImportMatches,
  hasBlueprintStructure,
  isBlueprintPrewriteConflict,
  sameBlueprintValue,
} from "./citadel-blueprint-binding";
import {
  citadelStructureAttempt,
  citadelStructureLocked,
  setCitadelStructureAttempt,
  subscribeCitadelStructureAttempts,
} from "./citadel-structure-state";
import type { MasonReview } from "./use-citadel-mason";
import { getErrorMessage } from "../shared/native-helpers";

export function useMasonStaging(citadelId: string, candidate: MasonReview | null, editorIdentity: string) {
  const installation = getGatewayApiBaseUrl();
  const identity = JSON.stringify([installation, citadelId, candidate, editorIdentity]);
  const live = useRef({ identity, mounted: true, generation: 0 });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation++;
  }
  const [review, setReview] = useState<{
    target: CitadelStructureSnapshot;
    candidate: MasonReview;
    generation: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null),
    [checking, setChecking] = useState(false);
  const attempt = useSyncExternalStore(
    subscribeCitadelStructureAttempts,
    () => citadelStructureAttempt(citadelId, installation),
    () => citadelStructureAttempt(citadelId, installation),
  );
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    setReview(null);
    setNotice(null);
    setChecking(false);
    return () => {
      owner.mounted = false;
      owner.generation++;
    };
  }, [identity]);
  const currentAt = (generation: number) =>
    live.current.mounted && live.current.generation === generation && getGatewayApiBaseUrl() === installation;
  const locked = () => citadelStructureLocked(citadelId, installation);
  const setAttempt = (value: Parameters<typeof setCitadelStructureAttempt>[1]) =>
    setCitadelStructureAttempt(citadelId, value, installation);
  async function prepare() {
    if (!candidate || locked() || checking) return;
    const generation = ++live.current.generation,
      captured = structuredClone(candidate);
    setChecking(true);
    setNotice(null);
    setReview(null);
    try {
      const target = await getCitadelStructureSnapshot(citadelId);
      if (!currentAt(generation) || locked()) return;
      if (!hasBlueprintStructure(target, citadelId) || !target.record || target.record.lifecycleStatus === "archived")
        throw new Error("An active Citadel and current structure revision are required for staging.");
      setReview({ target, candidate: captured, generation });
    } catch (error) {
      if (currentAt(generation)) setNotice(getErrorMessage(error));
    } finally {
      if (currentAt(generation)) setChecking(false);
    }
  }
  function cancel() {
    if (["saving", "uncertain"].includes(citadelStructureAttempt(citadelId, installation).phase)) return;
    live.current.generation++;
    setReview(null);
    setChecking(false);
  }
  async function confirm() {
    if (!review || locked() || !currentAt(review.generation)) return false;
    const captured = structuredClone(review);
    let dispatched = false;
    setAttempt({ phase: "checking", message: "Checking the reviewed Citadel structure…" });
    try {
      const session = await getMasonSession(captured.candidate.session.sessionId);
      if (!currentAt(captured.generation)) return false;
      if (!sameBlueprintValue(session, captured.candidate.session))
        throw new Error("Mason answers changed. Draft and review again before staging.");
      const fresh = await getCitadelStructureSnapshot(citadelId);
      if (!currentAt(captured.generation)) return false;
      if (!sameBlueprintValue(fresh, captured.target))
        throw new Error("The Citadel changed. Review staging again before applying.");
      setAttempt({ phase: "saving", message: "Waiting for the Citadel staging owner…" });
      dispatched = true;
      const receipt = await stageMasonBlueprint(citadelId, captured.candidate.blueprint, captured.target.revision);
      if (
        getGatewayApiBaseUrl() !== installation ||
        !blueprintImportMatches(captured.target, captured.candidate.blueprint, receipt.citadel) ||
        !sameBlueprintValue(receipt.review, captured.candidate.summary)
      )
        throw new Error("The staging receipt does not match the reviewed Blueprint.");
      const after = await getCitadelStructureSnapshot(citadelId);
      if (getGatewayApiBaseUrl() !== installation || !sameBlueprintValue(after, receipt.citadel))
        throw new Error("The staged structure could not be independently confirmed.");
      setAttempt({ phase: "idle" });
      if (currentAt(captured.generation)) {
        setReview(null);
        setNotice("Blueprint staged and confirmed. No accounts were connected and no Gates were opened.");
      }
      return true;
    } catch (error) {
      if (dispatched && !isBlueprintPrewriteConflict(error)) {
        setAttempt({
          phase: "uncertain",
          message:
            "Citadel staging outcome is unconfirmed. Further structure changes are withheld in this app session; inspect the Citadel before continuing.",
        });
      } else {
        setAttempt({ phase: "idle" });
        if (currentAt(captured.generation)) setNotice(getErrorMessage(error));
      }
      if (currentAt(captured.generation)) setReview(null);
      return false;
    } finally {
      if (!dispatched) setAttempt({ phase: "idle" });
    }
  }
  return { review, notice, checking, attempt, locked: attempt.phase !== "idle", prepare, cancel, confirm };
}
