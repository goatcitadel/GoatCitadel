import { turnReadsDraft } from "./use-turn-actions";
import { WORKFLOW_SKILL_CAPTURE_MARKER, type ChatThreadTurnRecord } from "@goatcitadel/contracts";

/**
 * Where "Save as skill" stands for one turn. Only a finished answer with text can become a skill, so any other turn
 * hides it. A capture draft (the turn that holds generated skill instructions) always shows its review block; an
 * ordinary finished answer only offers it from the More menu until the operator asks, so it does not sit under
 * every answer.
 */
export function skillCaptureVisibility(turn: ChatThreadTurnRecord, requested: boolean): "hidden" | "offered" | "shown" {
  if (!turnReadsDraft(turn) || !turn.assistantMessage?.content) return "hidden";
  if (turn.userMessage.content.startsWith(WORKFLOW_SKILL_CAPTURE_MARKER) || requested) return "shown";
  return "offered";
}
