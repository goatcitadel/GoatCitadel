import { z } from "zod";

export const SESSION_CONTROL_OPERATIONS = [
  "read",
  "send",
  "heartbeat",
  "reconnect",
  "handoff",
  "release",
  "revoke",
] as const;
export const EXTERNAL_SESSION_CONTROL_CAPABILITIES = ["send", "read"] as const;
export const SESSION_CONTROL_PROTOCOL_OPERATIONS = ["heartbeat", "reconnect", "release"] as const;
export const OPERATOR_SESSION_CONTROL_ACTIONS = ["handoff", "revoke"] as const;
export const SESSION_CONTROL_OWNER_KINDS = ["operator", "external_companion"] as const;
export const SESSION_CONTROL_LEASE_STATES = [
  "operator_active",
  "external_live",
  "external_stale",
  "released",
  "revoked",
  "superseded",
  "deleted",
] as const;
export const SESSION_CONTROL_REQUEST_STATUSES = ["pending", "rejected", "expired", "activated", "cancelled"] as const;
export const SESSION_CONTROL_CONFLICT_CODES = [
  "SESSION_CONTROLLED_EXTERNALLY",
  "SESSION_CONTROL_GENERATION_STALE",
  "SESSION_CONTROL_STALE",
  "SESSION_CONTROL_RECONNECT_EXPIRED",
  "SESSION_CONTROL_TOKEN_INVALID",
  "SESSION_CONTROL_CAPABILITY_DENIED",
  "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED",
  "SESSION_CONTROL_STATE_CORRUPT",
] as const;
export const SESSION_CONTROL_EVENT_REASON_CODES = [
  "session_initialized",
  "request_created",
  "request_rejected",
  "request_expired",
  "request_cancelled",
  "handoff",
  "heartbeat",
  "lease_stale",
  "reconnect",
  "identity_revoked",
  "release",
  "operator_revoke",
  "emergency_takeover",
  "auth_revoked",
  "session_deleted",
  "session_reactivated",
  "mutation_denied",
] as const;

export const SESSION_CONTROL_TOKEN_TTL_SECONDS = 900;
export const SESSION_CONTROL_HEARTBEAT_CADENCE_SECONDS = 15;
export const SESSION_CONTROL_LIVE_LEASE_SECONDS = 60;
export const SESSION_CONTROL_RECONNECT_WINDOW_SECONDS = 300;
export const SESSION_CONTROL_MAX_LIST_ITEMS = 200;
export const SESSION_CONTROL_TOKEN_HEADER = "X-GoatCitadel-Session-Control-Token" as const;
export const SESSION_CONTROL_GENERATION_HEADER = "X-GoatCitadel-Control-Generation" as const;

export type SessionControlOperation = (typeof SESSION_CONTROL_OPERATIONS)[number];
export type ExternalSessionControlCapability = (typeof EXTERNAL_SESSION_CONTROL_CAPABILITIES)[number];
export type ExternalSessionControlCapabilitySet = readonly ["send"] | readonly ["send", "read"];
export type SessionControlProtocolOperation = (typeof SESSION_CONTROL_PROTOCOL_OPERATIONS)[number];
export type OperatorSessionControlAction = (typeof OPERATOR_SESSION_CONTROL_ACTIONS)[number];
export type SessionControlOwnerKind = (typeof SESSION_CONTROL_OWNER_KINDS)[number];
export type SessionControlLeaseState = (typeof SESSION_CONTROL_LEASE_STATES)[number];
export type SessionControlRequestStatus = (typeof SESSION_CONTROL_REQUEST_STATUSES)[number];
export type SessionControlConflictCode = (typeof SESSION_CONTROL_CONFLICT_CODES)[number];
export type SessionControlEventReasonCode = (typeof SESSION_CONTROL_EVENT_REASON_CODES)[number];

interface SessionControlEventTransitionShape {
  previousGeneration?: number;
  nextGeneration: number;
  previousOwnerKind?: SessionControlOwnerKind;
  nextOwnerKind?: SessionControlOwnerKind;
  previousLeaseState?: SessionControlLeaseState;
  nextLeaseState: SessionControlLeaseState;
  reasonCode: SessionControlEventReasonCode;
  actorKind: "operator" | "external_companion" | "system";
}

const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine(
    (value) => {
      const timestamp = Date.parse(value);
      return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
    },
    { message: "Timestamp is invalid." },
  );
const GenerationSchema = z.number().int().positive().safe();
const TokenFingerprintSchema = z.string().regex(/^[0-9a-f]{8}$/u);
const SessionControlTokenHashSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const EventReasonCodeSchema = z.enum(SESSION_CONTROL_EVENT_REASON_CODES);

const ExternalSessionControlCapabilitySetSchema = z.unknown().transform((input, context) => {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control capability set is invalid." });
    return z.NEVER;
  }
  const values = new Set<ExternalSessionControlCapability>();
  for (const entry of input) {
    if (entry !== "send" && entry !== "read") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control capability set is invalid." });
      return z.NEVER;
    }
    if (values.has(entry)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control capability set is invalid." });
      return z.NEVER;
    }
    values.add(entry);
  }
  if (!values.has("send")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control capability set is invalid." });
    return z.NEVER;
  }
  return Object.freeze(values.has("read") ? (["send", "read"] as const) : (["send"] as const));
});

const ProjectedExternalCapabilitySetSchema = z
  .union([z.tuple([z.literal("send")]), z.tuple([z.literal("send"), z.literal("read")])])
  .transform((capabilities) =>
    capabilities.length === 1 ? Object.freeze(["send"] as const) : Object.freeze(["send", "read"] as const),
  );
const EmptyCapabilitySetSchema = z.tuple([]).transform(() => Object.freeze([]) as readonly []);

const BoundExternalControllerSummarySchema = z
  .object({
    companionSessionId: IdentifierSchema,
    clientInstanceId: IdentifierSchema,
    principalPurpose: z.literal("session_control_client"),
    tokenFingerprint: TokenFingerprintSchema,
  })
  .strict();

const ControlProjectionBaseShape = {
  workspaceId: IdentifierSchema,
  sessionId: IdentifierSchema,
  generation: GenerationSchema,
  lastEventId: IdentifierSchema,
  lastEventReasonCode: EventReasonCodeSchema,
  updatedAt: TimestampSchema,
} as const;

const OPERATOR_CURRENT_EVENT_REASONS = new Set<SessionControlEventReasonCode>([
  "session_initialized",
  "request_created",
  "request_rejected",
  "request_expired",
  "request_cancelled",
  "identity_revoked",
  "release",
  "operator_revoke",
  "emergency_takeover",
  "auth_revoked",
  "session_reactivated",
  "mutation_denied",
]);
const EXTERNAL_CURRENT_EVENT_REASONS = new Set<SessionControlEventReasonCode>([
  "request_rejected",
  "request_expired",
  "request_cancelled",
  "handoff",
  "heartbeat",
  "lease_stale",
  "reconnect",
  "mutation_denied",
]);
const OPERATOR_EXTERNAL_RETURN_EVENT_REASONS = new Set<SessionControlEventReasonCode>([
  "identity_revoked",
  "release",
  "operator_revoke",
  "emergency_takeover",
  "auth_revoked",
]);

const OperatorSessionControlRecordSchema = z
  .object({
    ...ControlProjectionBaseShape,
    ownerKind: z.literal("operator"),
    leaseState: z.literal("operator_active"),
    capabilities: EmptyCapabilitySetSchema,
  })
  .strict()
  .superRefine((control, context) => {
    if (
      !OPERATOR_CURRENT_EVENT_REASONS.has(control.lastEventReasonCode) ||
      (control.lastEventReasonCode === "session_initialized" && control.generation !== 1) ||
      (OPERATOR_EXTERNAL_RETURN_EVENT_REASONS.has(control.lastEventReasonCode) && control.generation < 3) ||
      (control.lastEventReasonCode === "session_reactivated" && control.generation < 2)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Operator control projection is invalid." });
    }
  });
const ExternalSessionControlRecordSchema = z
  .object({
    ...ControlProjectionBaseShape,
    ownerKind: z.literal("external_companion"),
    leaseState: z.enum(["external_live", "external_stale"]),
    capabilities: ProjectedExternalCapabilitySetSchema,
    boundExternalController: BoundExternalControllerSummarySchema,
    lastHeartbeatAt: TimestampSchema,
    leaseExpiresAt: TimestampSchema,
    reconnectExpiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((control, context) => {
    const heartbeatAt = Date.parse(control.lastHeartbeatAt);
    const leaseExpiresAt = Date.parse(control.leaseExpiresAt);
    const reconnectExpiresAt = Date.parse(control.reconnectExpiresAt);
    const updatedAt = Date.parse(control.updatedAt);
    const liveReason = ["handoff", "heartbeat", "reconnect"].includes(control.lastEventReasonCode);
    const reasonMatchesLease =
      (control.lastEventReasonCode === "lease_stale" && control.leaseState === "external_stale") ||
      (liveReason && control.leaseState === "external_live") ||
      (!liveReason && control.lastEventReasonCode !== "lease_stale");
    if (
      !EXTERNAL_CURRENT_EVENT_REASONS.has(control.lastEventReasonCode) ||
      control.generation < 2 ||
      (control.lastEventReasonCode === "reconnect" && control.generation < 3) ||
      !reasonMatchesLease ||
      leaseExpiresAt !== heartbeatAt + SESSION_CONTROL_LIVE_LEASE_SECONDS * 1_000 ||
      reconnectExpiresAt !== heartbeatAt + SESSION_CONTROL_RECONNECT_WINDOW_SECONDS * 1_000 ||
      updatedAt < heartbeatAt
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "External control projection is invalid." });
    }
  });
const SessionControlRecordSchema = z.union([OperatorSessionControlRecordSchema, ExternalSessionControlRecordSchema]);

const SessionControlRequestBaseShape = {
  requestId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  sessionId: IdentifierSchema,
  companionSessionId: IdentifierSchema,
  clientInstanceId: IdentifierSchema,
  tokenFingerprint: TokenFingerprintSchema,
  requestedCapabilities: ProjectedExternalCapabilitySetSchema,
  requestedGeneration: GenerationSchema,
  idempotencyKey: IdentifierSchema,
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
} as const;
const PendingSessionControlRequestRecordSchema = z
  .object({ ...SessionControlRequestBaseShape, status: z.literal("pending") })
  .strict()
  .superRefine(validatePendingRequestChronology);
const RejectedSessionControlRequestRecordSchema = z
  .object({
    ...SessionControlRequestBaseShape,
    status: z.literal("rejected"),
    decidedAt: TimestampSchema,
    decidedByActorId: IdentifierSchema,
    decisionReasonCode: z.literal("request_rejected"),
  })
  .strict()
  .superRefine(validateResolvedRequestChronology);
const ExpiredSessionControlRequestRecordSchema = z
  .object({
    ...SessionControlRequestBaseShape,
    status: z.literal("expired"),
    decidedAt: TimestampSchema,
    decidedByActorId: IdentifierSchema,
    decisionReasonCode: z.literal("request_expired"),
  })
  .strict()
  .superRefine(validateExpiredRequestChronology);
const CancelledSessionControlRequestRecordSchema = z
  .object({
    ...SessionControlRequestBaseShape,
    status: z.literal("cancelled"),
    decidedAt: TimestampSchema,
    decidedByActorId: IdentifierSchema,
    decisionReasonCode: z.literal("request_cancelled"),
  })
  .strict()
  .superRefine(validateResolvedRequestChronology);
const ActivatedSessionControlRequestRecordSchema = z
  .object({
    ...SessionControlRequestBaseShape,
    status: z.literal("activated"),
    activatedGeneration: GenerationSchema,
    decidedAt: TimestampSchema,
    decidedByActorId: IdentifierSchema,
    decisionReasonCode: z.literal("handoff"),
  })
  .strict()
  .superRefine((request, context) => {
    validateResolvedRequestChronology(request, context);
    if (
      request.requestedGeneration === Number.MAX_SAFE_INTEGER ||
      request.activatedGeneration !== request.requestedGeneration + 1
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control request generation is invalid." });
    }
  });
const SessionControlRequestRecordSchema = z.union([
  PendingSessionControlRequestRecordSchema,
  RejectedSessionControlRequestRecordSchema,
  ExpiredSessionControlRequestRecordSchema,
  CancelledSessionControlRequestRecordSchema,
  ActivatedSessionControlRequestRecordSchema,
]);

const SessionControlEventRecordSchema = z
  .object({
    eventId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    sessionId: IdentifierSchema,
    previousGeneration: GenerationSchema.optional(),
    nextGeneration: GenerationSchema,
    previousOwnerKind: z.enum(SESSION_CONTROL_OWNER_KINDS).optional(),
    nextOwnerKind: z.enum(SESSION_CONTROL_OWNER_KINDS).optional(),
    previousLeaseState: z.enum(SESSION_CONTROL_LEASE_STATES).optional(),
    nextLeaseState: z.enum(SESSION_CONTROL_LEASE_STATES),
    reasonCode: EventReasonCodeSchema,
    actorKind: z.enum(["operator", "external_companion", "system"]),
    actorId: IdentifierSchema,
    correlationId: IdentifierSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine(validateSessionControlEventTransition);

const SessionControlRequestInputSchema = z
  .object({
    expectedGeneration: GenerationSchema,
    clientInstanceId: IdentifierSchema,
    tokenHashSha256: SessionControlTokenHashSha256Schema,
    capabilities: ExternalSessionControlCapabilitySetSchema,
    idempotencyKey: IdentifierSchema,
  })
  .strict();
const SessionControlHandoffInputSchema = z
  .object({
    requestId: IdentifierSchema,
    expectedGeneration: GenerationSchema,
    effectiveCapabilities: ExternalSessionControlCapabilitySetSchema,
    idempotencyKey: IdentifierSchema,
  })
  .strict();
const SessionControlHeartbeatInputSchema = z
  .object({ expectedGeneration: GenerationSchema, idempotencyKey: IdentifierSchema })
  .strict();
const SessionControlReconnectInputSchema = z
  .object({
    expectedGeneration: GenerationSchema,
    newTokenHashSha256: SessionControlTokenHashSha256Schema,
    idempotencyKey: IdentifierSchema,
  })
  .strict();
const SessionControlReleaseInputSchema = z
  .object({ expectedGeneration: GenerationSchema, idempotencyKey: IdentifierSchema })
  .strict();
const SessionControlRevokeInputSchema = z.union([
  z.object({ target: z.literal("request"), requestId: IdentifierSchema, idempotencyKey: IdentifierSchema }).strict(),
  z
    .object({
      target: z.literal("current_controller"),
      expectedGeneration: GenerationSchema,
      mode: z.enum(["revoke", "emergency_takeover"]),
      idempotencyKey: IdentifierSchema,
    })
    .strict(),
]);

const SessionControlRequestResponseSchema = z.object({ request: PendingSessionControlRequestRecordSchema }).strict();
const SessionControlHandoffResponseSchema = z
  .object({ request: ActivatedSessionControlRequestRecordSchema, control: ExternalSessionControlRecordSchema })
  .strict()
  .superRefine(validateHandoffResponse);
const SessionControlHeartbeatResponseSchema = z
  .object({ generation: GenerationSchema, control: ExternalSessionControlRecordSchema })
  .strict()
  .superRefine((response, context) => {
    if (response.control.leaseState !== "external_live" || response.control.generation !== response.generation) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control heartbeat response is invalid." });
    }
  });
const SessionControlReconnectResponseSchema = z
  .object({ supersededGeneration: GenerationSchema, control: ExternalSessionControlRecordSchema })
  .strict()
  .superRefine((response, context) => {
    if (
      response.control.leaseState !== "external_live" ||
      response.control.lastEventReasonCode !== "reconnect" ||
      !isExactGenerationIncrement(response.supersededGeneration, response.control.generation)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control reconnect response is invalid." });
    }
  });
const SessionControlReleaseResponseSchema = z
  .object({ releasedGeneration: GenerationSchema, control: OperatorSessionControlRecordSchema })
  .strict()
  .superRefine((response, context) => {
    if (
      response.control.lastEventReasonCode !== "release" ||
      !isExactGenerationIncrement(response.releasedGeneration, response.control.generation)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control release response is invalid." });
    }
  });
const SessionControlRevokeResponseSchema = z.union([
  z.object({ target: z.literal("request"), request: CancelledSessionControlRequestRecordSchema }).strict(),
  z
    .object({
      target: z.literal("current_controller"),
      revokedGeneration: GenerationSchema,
      mode: z.enum(["revoke", "emergency_takeover"]),
      control: OperatorSessionControlRecordSchema,
    })
    .strict()
    .superRefine((response, context) => {
      const expectedReason = response.mode === "revoke" ? "operator_revoke" : "emergency_takeover";
      if (
        response.control.lastEventReasonCode !== expectedReason ||
        !isExactGenerationIncrement(response.revokedGeneration, response.control.generation)
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control revoke response is invalid." });
      }
    }),
]);
const OperatorSessionControlDetailResponseSchema = z
  .object({
    control: OperatorSessionControlRecordSchema,
    pendingRequests: z
      .array(PendingSessionControlRequestRecordSchema)
      .max(SESSION_CONTROL_MAX_LIST_ITEMS)
      .transform((items) => Object.freeze(items)),
  })
  .strict()
  .superRefine((response, context) => {
    const requestIds = new Set<string>();
    const idempotencyKeys = new Set<string>();
    if (
      response.pendingRequests.some(
        (request) =>
          request.workspaceId !== response.control.workspaceId || request.sessionId !== response.control.sessionId,
      ) ||
      response.pendingRequests.some((request) => request.requestedGeneration !== response.control.generation) ||
      response.pendingRequests.some((request) => {
        const duplicate = requestIds.has(request.requestId) || idempotencyKeys.has(request.idempotencyKey);
        requestIds.add(request.requestId);
        idempotencyKeys.add(request.idempotencyKey);
        return duplicate;
      })
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control detail response is invalid." });
    }
  });
const ExternalSessionControlDetailResponseSchema = z
  .object({
    control: ExternalSessionControlRecordSchema,
    pendingRequests: z.tuple([]).transform(() => Object.freeze([]) as readonly []),
  })
  .strict();
const SessionControlDetailResponseSchema = z.union([
  OperatorSessionControlDetailResponseSchema,
  ExternalSessionControlDetailResponseSchema,
]);
const SessionControlListResponseSchema = z
  .object({
    items: z
      .array(SessionControlRecordSchema)
      .max(SESSION_CONTROL_MAX_LIST_ITEMS)
      .transform((items) => Object.freeze(items)),
  })
  .strict()
  .superRefine((response, context) => {
    const sessionIds = new Set<string>();
    if (
      response.items.some((control) => {
        const duplicate = sessionIds.has(control.sessionId);
        sessionIds.add(control.sessionId);
        return duplicate;
      })
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control list response is invalid." });
    }
  });

type DeepReadonly<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends (...arguments_: never[]) => unknown
    ? T
    : T extends readonly unknown[]
      ? { readonly [Index in keyof T]: DeepReadonly<T[Index]> }
      : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };

export type SessionControlBoundExternalControllerSummary = DeepReadonly<
  z.infer<typeof BoundExternalControllerSummarySchema>
>;
export type SessionControlRecord = DeepReadonly<z.infer<typeof SessionControlRecordSchema>>;
export type SessionControlRequestRecord = DeepReadonly<z.infer<typeof SessionControlRequestRecordSchema>>;
export type SessionControlEventRecord = DeepReadonly<z.infer<typeof SessionControlEventRecordSchema>>;
export type SessionControlRequestInput = DeepReadonly<z.infer<typeof SessionControlRequestInputSchema>>;
export type SessionControlRequestResponse = DeepReadonly<z.infer<typeof SessionControlRequestResponseSchema>>;
export type SessionControlHandoffInput = DeepReadonly<z.infer<typeof SessionControlHandoffInputSchema>>;
export type SessionControlHandoffResponse = DeepReadonly<z.infer<typeof SessionControlHandoffResponseSchema>>;
export type SessionControlHeartbeatInput = DeepReadonly<z.infer<typeof SessionControlHeartbeatInputSchema>>;
export type SessionControlHeartbeatResponse = DeepReadonly<z.infer<typeof SessionControlHeartbeatResponseSchema>>;
export type SessionControlReconnectInput = DeepReadonly<z.infer<typeof SessionControlReconnectInputSchema>>;
export type SessionControlReconnectResponse = DeepReadonly<z.infer<typeof SessionControlReconnectResponseSchema>>;
export type SessionControlReleaseInput = DeepReadonly<z.infer<typeof SessionControlReleaseInputSchema>>;
export type SessionControlReleaseResponse = DeepReadonly<z.infer<typeof SessionControlReleaseResponseSchema>>;
export type SessionControlRevokeInput = DeepReadonly<z.infer<typeof SessionControlRevokeInputSchema>>;
export type SessionControlRevokeResponse = DeepReadonly<z.infer<typeof SessionControlRevokeResponseSchema>>;
export type SessionControlDetailResponse = DeepReadonly<z.infer<typeof SessionControlDetailResponseSchema>>;
export type SessionControlListResponse = DeepReadonly<z.infer<typeof SessionControlListResponseSchema>>;

export const parseSessionControlRecord = parser(SessionControlRecordSchema, "Session control record is invalid.");
export const parseSessionControlRequestRecord = parser(
  SessionControlRequestRecordSchema,
  "Session control request record is invalid.",
);
export const parseSessionControlEventRecord = parser(
  SessionControlEventRecordSchema,
  "Session control event record is invalid.",
);
export const parseSessionControlRequestInput = parser(
  SessionControlRequestInputSchema,
  "Session control request is invalid.",
);
export const parseSessionControlHandoffInput = parser(
  SessionControlHandoffInputSchema,
  "Session control handoff is invalid.",
);
export const parseSessionControlHeartbeatInput = parser(
  SessionControlHeartbeatInputSchema,
  "Session control heartbeat is invalid.",
);
export const parseSessionControlReconnectInput = parser(
  SessionControlReconnectInputSchema,
  "Session control reconnect is invalid.",
);
export const parseSessionControlReleaseInput = parser(
  SessionControlReleaseInputSchema,
  "Session control release is invalid.",
);
export const parseSessionControlRevokeInput = parser(
  SessionControlRevokeInputSchema,
  "Session control revoke is invalid.",
);
export const parseSessionControlRequestResponse = parser(
  SessionControlRequestResponseSchema,
  "Session control request response is invalid.",
);
export const parseSessionControlHandoffResponse = parser(
  SessionControlHandoffResponseSchema,
  "Session control handoff response is invalid.",
);
export const parseSessionControlHeartbeatResponse = parser(
  SessionControlHeartbeatResponseSchema,
  "Session control heartbeat response is invalid.",
);
export const parseSessionControlReconnectResponse = parser(
  SessionControlReconnectResponseSchema,
  "Session control reconnect response is invalid.",
);
export const parseSessionControlReleaseResponse = parser(
  SessionControlReleaseResponseSchema,
  "Session control release response is invalid.",
);
export const parseSessionControlRevokeResponse = parser(
  SessionControlRevokeResponseSchema,
  "Session control revoke response is invalid.",
);
export const parseSessionControlDetailResponse = parser(
  SessionControlDetailResponseSchema,
  "Session control detail response is invalid.",
);
export const parseSessionControlListResponse = parser(
  SessionControlListResponseSchema,
  "Session control list response is invalid.",
);

export function normalizeExternalSessionControlCapabilities(input: unknown): ExternalSessionControlCapabilitySet {
  return parseSecretSafe(
    ExternalSessionControlCapabilitySetSchema,
    input,
    "Session control capability set is invalid.",
  );
}

export function assertSessionControlEffectiveCapabilities(
  requestedInput: unknown,
  effectiveInput: unknown,
): ExternalSessionControlCapabilitySet {
  const requested = normalizeExternalSessionControlCapabilities(requestedInput);
  const effective = normalizeExternalSessionControlCapabilities(effectiveInput);
  const requestedSet = new Set(requested);
  if (effective.some((capability) => !requestedSet.has(capability))) {
    throw new TypeError("Session control effective capability set is invalid.");
  }
  return effective;
}

export function normalizeSessionControlTokenHashSha256(input: unknown): string {
  return parseSecretSafe(SessionControlTokenHashSha256Schema, input, "Session control token hash is invalid.");
}

export function sessionControlTokenFingerprint(input: unknown): string {
  return normalizeSessionControlTokenHashSha256(input).slice(-8);
}

export function parseSessionControlGenerationHeader(input: unknown): number {
  if (typeof input !== "string" || !/^[1-9][0-9]*$/u.test(input)) {
    throw new TypeError("Session control generation header is invalid.");
  }
  const generation = Number(input);
  if (!Number.isSafeInteger(generation)) throw new TypeError("Session control generation header is invalid.");
  return generation;
}

export function assertSessionControlHeartbeatTransition(previousGeneration: number, nextGeneration: number): void {
  assertGeneration(previousGeneration);
  assertGeneration(nextGeneration);
  if (nextGeneration !== previousGeneration) throw new TypeError("Heartbeat must retain the controller generation.");
}

export function assertSessionControlReconnectTransition(previousGeneration: number, nextGeneration: number): void {
  assertIncrementingTransition(previousGeneration, nextGeneration, "Reconnect");
}

export function assertSessionControlHandoffTransition(previousGeneration: number, nextGeneration: number): void {
  assertIncrementingTransition(previousGeneration, nextGeneration, "Handoff");
}

export function assertSessionControlReleaseTransition(previousGeneration: number, nextGeneration: number): void {
  assertIncrementingTransition(previousGeneration, nextGeneration, "Release");
}

export function assertSessionControlRevokeTransition(previousGeneration: number, nextGeneration: number): void {
  assertIncrementingTransition(previousGeneration, nextGeneration, "Revoke");
}

function parser<Schema extends z.ZodTypeAny>(schema: Schema, message: string) {
  return (input: unknown): DeepReadonly<z.output<Schema>> => parseSecretSafe(schema, input, message);
}

function parseSecretSafe<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  message: string,
): DeepReadonly<z.output<Schema>> {
  try {
    const snapshot = snapshotPlainData(input, { nodes: 0 }, 0);
    const parsed = schema.safeParse(snapshot);
    if (!parsed.success) throw new TypeError(message);
    return deepFreeze(parsed.data);
  } catch {
    throw new TypeError(message);
  }
}

function snapshotPlainData(value: unknown, state: { nodes: number }, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  state.nodes += 1;
  if (depth > 12 || state.nodes > 10_000) throw new TypeError("Untrusted value exceeds structural bounds.");

  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 1_000) {
      throw new TypeError("Untrusted array is invalid.");
    }
    const expectedKeys = value.length + 1;
    if (keys.length !== expectedKeys || !keys.includes("length")) throw new TypeError("Untrusted array is invalid.");
    const snapshot: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Untrusted array is invalid.");
      }
      snapshot.push(snapshotPlainData(descriptor.value, state, depth + 1));
    }
    return snapshot;
  }

  if (prototype !== Object.prototype || keys.length > 64) throw new TypeError("Untrusted object is invalid.");
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError("Untrusted object is invalid.");
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Untrusted object is invalid.");
    }
    Object.defineProperty(snapshot, key, {
      value: snapshotPlainData(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return snapshot;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (value === null || typeof value !== "object") return value as DeepReadonly<T>;
  if (seen.has(value)) return value as DeepReadonly<T>;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

function validatePendingRequestChronology(
  request: { createdAt: string; expiresAt: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(request.createdAt) >= Date.parse(request.expiresAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control request chronology is invalid." });
  }
}

function validateResolvedRequestChronology(
  request: { createdAt: string; expiresAt: string; decidedAt: string },
  context: z.RefinementCtx,
): void {
  validatePendingRequestChronology(request, context);
  const decidedAt = Date.parse(request.decidedAt);
  if (decidedAt < Date.parse(request.createdAt) || decidedAt >= Date.parse(request.expiresAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control decision chronology is invalid." });
  }
}

function validateExpiredRequestChronology(
  request: { createdAt: string; expiresAt: string; decidedAt: string },
  context: z.RefinementCtx,
): void {
  validatePendingRequestChronology(request, context);
  if (Date.parse(request.decidedAt) < Date.parse(request.expiresAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control expiry chronology is invalid." });
  }
}

function validateHandoffResponse(
  response: z.infer<typeof ActivatedSessionControlRequestRecordSchema> extends infer _Request
    ? {
        request: z.infer<typeof ActivatedSessionControlRequestRecordSchema>;
        control: z.infer<typeof ExternalSessionControlRecordSchema>;
      }
    : never,
  context: z.RefinementCtx,
): void {
  const { request, control } = response;
  const requested = new Set(request.requestedCapabilities);
  if (
    control.leaseState !== "external_live" ||
    control.lastEventReasonCode !== "handoff" ||
    control.workspaceId !== request.workspaceId ||
    control.sessionId !== request.sessionId ||
    control.generation !== request.activatedGeneration ||
    control.boundExternalController.companionSessionId !== request.companionSessionId ||
    control.boundExternalController.clientInstanceId !== request.clientInstanceId ||
    control.boundExternalController.tokenFingerprint !== request.tokenFingerprint ||
    control.capabilities.some((capability) => !requested.has(capability))
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control handoff response is invalid." });
  }
}

function validateSessionControlEventTransition(
  event: SessionControlEventTransitionShape,
  context: z.RefinementCtx,
): void {
  const sameGeneration = event.previousGeneration !== undefined && event.nextGeneration === event.previousGeneration;
  const nextGeneration =
    event.previousGeneration !== undefined &&
    isExactGenerationIncrement(event.previousGeneration, event.nextGeneration);
  const sameOwner = event.previousOwnerKind !== undefined && event.nextOwnerKind === event.previousOwnerKind;
  const sameLease = event.previousLeaseState !== undefined && event.nextLeaseState === event.previousLeaseState;
  const externalToOperator = event.previousOwnerKind === "external_companion" && event.nextOwnerKind === "operator";
  let valid = false;
  switch (event.reasonCode) {
    case "session_initialized":
      valid =
        event.previousGeneration === undefined &&
        event.previousOwnerKind === undefined &&
        event.previousLeaseState === undefined &&
        event.nextGeneration === 1 &&
        event.nextOwnerKind === "operator" &&
        event.nextLeaseState === "operator_active" &&
        event.actorKind === "system";
      break;
    case "request_created":
      valid =
        sameGeneration &&
        sameOwner &&
        sameLease &&
        event.nextOwnerKind === "operator" &&
        event.nextLeaseState === "operator_active" &&
        event.actorKind === "external_companion";
      break;
    case "request_rejected":
    case "request_cancelled":
      valid = sameGeneration && sameOwner && sameLease && event.actorKind === "operator";
      break;
    case "request_expired":
      valid = sameGeneration && sameOwner && sameLease && event.actorKind === "system";
      break;
    case "handoff":
      valid =
        nextGeneration &&
        event.previousOwnerKind === "operator" &&
        event.nextOwnerKind === "external_companion" &&
        event.previousLeaseState === "operator_active" &&
        event.nextLeaseState === "external_live" &&
        event.actorKind === "operator";
      break;
    case "heartbeat":
      valid =
        sameGeneration &&
        sameOwner &&
        event.nextOwnerKind === "external_companion" &&
        event.previousLeaseState === "external_live" &&
        event.nextLeaseState === "external_live" &&
        event.actorKind === "external_companion";
      break;
    case "lease_stale":
      valid =
        sameGeneration &&
        sameOwner &&
        event.nextOwnerKind === "external_companion" &&
        event.previousLeaseState === "external_live" &&
        event.nextLeaseState === "external_stale" &&
        event.actorKind === "system";
      break;
    case "reconnect":
      valid =
        nextGeneration &&
        event.previousOwnerKind === "external_companion" &&
        event.nextOwnerKind === "external_companion" &&
        (event.previousLeaseState === "external_live" || event.previousLeaseState === "external_stale") &&
        event.nextLeaseState === "external_live" &&
        event.actorKind === "external_companion";
      break;
    case "release":
      valid =
        nextGeneration &&
        externalToOperator &&
        (event.previousLeaseState === "external_live" || event.previousLeaseState === "external_stale") &&
        event.nextLeaseState === "operator_active" &&
        event.actorKind === "external_companion";
      break;
    case "operator_revoke":
    case "emergency_takeover":
      valid =
        nextGeneration &&
        externalToOperator &&
        (event.previousLeaseState === "external_live" || event.previousLeaseState === "external_stale") &&
        event.nextLeaseState === "operator_active" &&
        event.actorKind === "operator";
      break;
    case "identity_revoked":
    case "auth_revoked":
      valid =
        nextGeneration &&
        externalToOperator &&
        (event.previousLeaseState === "external_live" || event.previousLeaseState === "external_stale") &&
        event.nextLeaseState === "operator_active" &&
        event.actorKind === "system";
      break;
    case "session_deleted":
      valid =
        sameGeneration &&
        event.previousOwnerKind === "operator" &&
        event.nextOwnerKind === undefined &&
        event.previousLeaseState === "operator_active" &&
        event.nextLeaseState === "deleted" &&
        event.actorKind === "operator";
      break;
    case "session_reactivated":
      valid =
        nextGeneration &&
        event.previousOwnerKind === undefined &&
        event.nextOwnerKind === "operator" &&
        event.previousLeaseState === "deleted" &&
        event.nextLeaseState === "operator_active" &&
        event.actorKind === "operator";
      break;
    case "mutation_denied":
      valid = sameGeneration && sameOwner && sameLease;
      break;
  }
  const previousAuthorityIsCoherent =
    event.previousGeneration === undefined
      ? event.previousOwnerKind === undefined && event.previousLeaseState === undefined
      : isSessionControlAuthorityGeneration(
          event.previousGeneration,
          event.previousOwnerKind,
          event.previousLeaseState,
        );
  const nextAuthorityIsCoherent = isSessionControlAuthorityGeneration(
    event.nextGeneration,
    event.nextOwnerKind,
    event.nextLeaseState,
  );
  valid &&= previousAuthorityIsCoherent && nextAuthorityIsCoherent;
  if (!valid)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Session control event transition is invalid." });
}

function isSessionControlAuthorityGeneration(
  generation: number,
  ownerKind: SessionControlOwnerKind | undefined,
  leaseState: SessionControlLeaseState | undefined,
): boolean {
  if (ownerKind === "operator") return leaseState === "operator_active";
  if (ownerKind === "external_companion") {
    return generation >= 2 && (leaseState === "external_live" || leaseState === "external_stale");
  }
  return leaseState === "deleted";
}

function isExactGenerationIncrement(previousGeneration: number, nextGeneration: number): boolean {
  return previousGeneration !== Number.MAX_SAFE_INTEGER && nextGeneration === previousGeneration + 1;
}

function assertIncrementingTransition(previousGeneration: number, nextGeneration: number, label: string): void {
  assertGeneration(previousGeneration);
  assertGeneration(nextGeneration);
  if (!isExactGenerationIncrement(previousGeneration, nextGeneration)) {
    throw new TypeError(`${label} must advance the controller generation exactly once.`);
  }
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError("Session control generation is invalid.");
  }
}
