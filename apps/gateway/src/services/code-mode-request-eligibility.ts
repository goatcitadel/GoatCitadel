/**
 * Whether a Chat turn is offered `code_mode.request`. The runner decides this for the step's tool schema and turn
 * preparation decides it for the base prompt and attachment hints, so both read the same rule from here. A prompt
 * that names a tool the step never offers invites a call the Claude Code CLI bridge fails closed.
 */

import {
  HEARTBEAT_PERMISSION_PROFILE_ID,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  type CodeModeReadiness,
  type ToolPolicyActorContext,
} from "@goatcitadel/contracts";

type ToolPolicyActorSource = NonNullable<ToolPolicyActorContext["authActorSource"]>;
/** Actors that never see `code_mode.request`: they cannot give the operator's approval in this Chat. */
const CODE_MODE_REQUEST_EXCLUDED_ACTOR_SOURCES: ReadonlySet<ToolPolicyActorSource> = new Set([
  "companion",
  "a2a_peer",
  "mesh_node",
]);
/** Operator-authenticated actors, whose approval card can turn Code Mode on. */
const CODE_MODE_REQUEST_OPERATOR_ACTOR_SOURCES: ReadonlySet<ToolPolicyActorSource> = new Set([
  "token",
  "basic",
  "loopback",
  "device",
]);

export interface CodeModeRequestTurnShape {
  mode: string;
  parentDelegationStepId?: string;
  serverOnlyPosture: boolean;
  restrictedAutonomousProfile: boolean;
  actorSource?: ToolPolicyActorSource;
}

/** The turn fields turn preparation and the runner both hold, from which each derives the same turn shape. */
export interface CodeModeRequestTurnFields {
  mode: string;
  parentDelegationStepId?: string;
  permissionProfileId?: string;
  /** Present only for an exact server-only (system heartbeat) turn. */
  serverOnlyPosture?: unknown;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
  /** Autonomous turns also carry their actor here; the request's own actor wins. */
  policyContext?: Pick<ToolPolicyActorContext, "authActorSource">;
}

/** The scheduled and heartbeat profiles that restrict an autonomous turn. */
export function isRestrictedAutonomousPermissionProfile(permissionProfileId: string | undefined): boolean {
  return (
    permissionProfileId === SCHEDULED_TURN_PERMISSION_PROFILE_ID ||
    permissionProfileId === HEARTBEAT_PERMISSION_PROFILE_ID
  );
}

/**
 * The one derivation of a turn's shape, so the prompt (what the model is told it can call) and the step schema (what
 * it is offered) cannot drift apart.
 */
export function buildCodeModeRequestTurnShape(turn: CodeModeRequestTurnFields): CodeModeRequestTurnShape {
  return {
    mode: turn.mode,
    parentDelegationStepId: turn.parentDelegationStepId,
    serverOnlyPosture: Boolean(turn.serverOnlyPosture),
    restrictedAutonomousProfile: isRestrictedAutonomousPermissionProfile(turn.permissionProfileId),
    actorSource: turn.authActorSource ?? turn.policyContext?.authActorSource,
  };
}

export interface CodeModeRequestEligibilityInput extends CodeModeRequestTurnShape {
  /** Absent when readiness could not be read; the turn is then not eligible. */
  readiness?: Pick<CodeModeReadiness, "canRun" | "sandboxSupported" | "reason">;
}

/**
 * The part of the rule that needs no readiness read: an interactive Chat turn, not a delegated child, a server-only
 * or restricted autonomous turn, or a companion, A2A or mesh actor.
 */
export function isCodeModeRequestTurnShapeEligible(input: CodeModeRequestTurnShape): boolean {
  return !(
    input.mode !== "chat" ||
    input.parentDelegationStepId ||
    input.serverOnlyPosture ||
    input.restrictedAutonomousProfile ||
    (input.actorSource !== undefined && CODE_MODE_REQUEST_EXCLUDED_ACTOR_SOURCES.has(input.actorSource))
  );
}

/**
 * `code_mode.request` is offered only in an interactive Chat turn the operator can approve. When Code Mode is off (or
 * its sandbox is switched off) it is still offered to an operator-authenticated session, whose approval card can turn
 * it on; it is never offered on a machine that cannot run the sandbox.
 */
export function resolveCodeModeRequestEligibility(input: CodeModeRequestEligibilityInput): boolean {
  const readiness = input.readiness;
  if (!readiness || !isCodeModeRequestTurnShapeEligible(input)) return false;
  if (readiness.canRun) return true;
  const canTurnOn =
    readiness.sandboxSupported && (readiness.reason === "code_mode_off" || readiness.reason === "sandbox_off");
  return (
    canTurnOn && input.actorSource !== undefined && CODE_MODE_REQUEST_OPERATOR_ACTOR_SOURCES.has(input.actorSource)
  );
}

/**
 * Reads readiness only for a turn whose shape is eligible, and fails closed: without a reader, or when the read
 * fails, the turn is not offered `code_mode.request`.
 */
export async function loadCodeModeRequestEligibility(
  turn: CodeModeRequestTurnShape,
  getCodeModeReadiness: (() => Promise<CodeModeReadiness>) | undefined,
): Promise<boolean> {
  if (!getCodeModeReadiness || !isCodeModeRequestTurnShapeEligible(turn)) return false;
  let readiness: CodeModeReadiness;
  try {
    readiness = await getCodeModeReadiness();
  } catch {
    return false;
  }
  return resolveCodeModeRequestEligibility({ ...turn, readiness });
}
