/**
 * Citadel sharing: role → capability permission matrix.
 * Implements spec §12.4.
 */

export type CitadelRole =
  | "owner"
  | "steward"
  | "builder"
  | "operator"
  | "contributor"
  | "viewer"
  | "guest"
  | "agent";

export type CitadelCapability =
  | "view"
  | "comment"
  | "contribute"
  | "run_missions"
  | "manage_council"
  | "manage_gates"
  | "manage_members"
  | "delete_citadel";

/**
 * Explicit capability grants per role (spec §12.4).
 *
 * owner     — all capabilities (full sovereignty over the Citadel).
 * steward   — everything except delete_citadel (trusted admin, cannot destroy).
 * builder   — can create missions/agents/automations; manages council but not gates/members/delete.
 * operator  — can view, comment, and run missions (execution-focused, no authoring).
 * contributor — can view, comment, and contribute content (no mission execution).
 * viewer    — read-only access.
 * guest     — read-only access (externally invited, same read grant as viewer).
 * agent     — non-human identity; may only execute granted missions.
 */
const ROLE_CAPABILITIES: Record<CitadelRole, ReadonlyArray<CitadelCapability>> = {
  owner: [
    "view",
    "comment",
    "contribute",
    "run_missions",
    "manage_council",
    "manage_gates",
    "manage_members",
    "delete_citadel",
  ],
  steward: [
    "view",
    "comment",
    "contribute",
    "run_missions",
    "manage_council",
    "manage_gates",
    "manage_members",
  ],
  builder: [
    "view",
    "comment",
    "contribute",
    "run_missions",
    "manage_council",
  ],
  operator: [
    "view",
    "comment",
    "run_missions",
  ],
  contributor: [
    "view",
    "comment",
    "contribute",
  ],
  viewer: [
    "view",
  ],
  guest: [
    "view",
  ],
  agent: [
    "run_missions",
  ],
} as const;

/**
 * Returns true when the given role is granted the specified capability.
 *
 * @param role       - The CitadelRole to check.
 * @param capability - The CitadelCapability being queried.
 */
export function roleCan(role: CitadelRole, capability: CitadelCapability): boolean {
  return (ROLE_CAPABILITIES[role] as ReadonlyArray<CitadelCapability>).includes(capability);
}
