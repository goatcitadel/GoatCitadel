import {
  extractMessageContent,
  parseSerializedToolCalls,
  readToolCalls,
  resolveAllowedModelToolCallName,
  type ParsedToolCall,
  type ToolCallProtocolIssue,
} from "./chat-agent-completion-adapters.js";

/**
 * P0-C tool-call repair.
 *
 * Local / open-weight models routinely emit tool calls that are *almost* valid:
 * a fuzzed tool name (`browser-search` vs `browser.search`), arguments wrapped
 * in a ```json fence, a one-element array instead of an object, or the whole
 * call serialized as prose / XML in the assistant text instead of the
 * structured `tool_calls` field. Failing the entire turn on these near-misses
 * wastes the turn; repairing them deterministically keeps the agent moving.
 *
 * SECURITY INVARIANT (deny-wins): repair MUST NOT widen the tool surface beyond
 * the active schema. Every candidate name a repair strategy produces is run
 * through {@link resolveAllowedModelToolCallName}, which fails closed — it
 * rejects names not in the active schema and rejects *all* names when the
 * registry is empty. Fuzzy matching only ever *narrows* an emitted name onto an
 * already-allowed canonical name; it can never invent access. A miss yields a
 * `role:"tool"` feedback message (listing the valid tool names) so the model can
 * self-correct on the next loop, never a silently-substituted call.
 *
 * The module is pure: no I/O, no policy calls, no mutation of inputs.
 */

export interface ToolCallRepairMaps {
  /** Provider-emitted (model-facing) tool name -> canonical tool name. */
  readonly modelToCanonical: Map<string, string>;
  /** Canonical tool name -> provider-facing (model-facing) tool name. */
  readonly canonicalToModel: Map<string, string>;
}

export interface ToolCallRepairFeedback {
  /** The tool_call id the feedback answers (echoed back as role:"tool"). */
  readonly toolCallId: string;
  /** Human/model-readable correction body (JSON-encoded payload). */
  readonly content: string;
}

export interface ToolCallRepairResult {
  /**
   * Full executable set: the calls that were already valid, plus the calls a
   * repair strategy recovered. Safe to feed straight into the tool-execution
   * branch — every entry resolved to an allowed canonical tool name.
   */
  readonly repaired: ParsedToolCall[];
  /** role:"tool" corrections for calls that could not be repaired. */
  readonly feedback: ToolCallRepairFeedback[];
  /** Issues no strategy could resolve (each has a matching feedback entry). */
  readonly unresolved: ToolCallProtocolIssue[];
}

/**
 * Maximum edit distance for fuzzy name resolution. Kept tight (<=2) so we only
 * absorb transcription-level slips (separator swaps, single typos), never map a
 * genuinely different tool onto an allowed one.
 */
const MAX_NAME_EDIT_DISTANCE = 2;

export function repairToolCalls(
  message: Record<string, unknown>,
  issues: ToolCallProtocolIssue[],
  maps: ToolCallRepairMaps,
): ToolCallRepairResult {
  const rawToolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as Array<Record<string, unknown>>)
    : [];

  const repaired: ParsedToolCall[] = [];
  const feedback: ToolCallRepairFeedback[] = [];
  const unresolved: ToolCallProtocolIssue[] = [];

  // inspectToolCallProtocolIssues and readToolCalls both walk message.tool_calls
  // in array order, so group issues onto their originating raw call positionally.
  // A single raw call can carry more than one issue (e.g. an unsupported name
  // AND bad args); we repair per raw call once, which keeps the executable set
  // free of the duplicate/empty-arg shadow readToolCalls would otherwise emit.
  const issuesByPosition = groupIssuesByPosition(rawToolCalls, issues);
  const matchedIssues = new Set<ToolCallProtocolIssue>();

  rawToolCalls.forEach((rawCall, index) => {
    const callIssues = issuesByPosition.get(index) ?? [];
    if (callIssues.length === 0) {
      // Clean call: parse exactly as the orchestrator would (allowed names only).
      repaired.push(...readSingleCleanCall(rawCall, maps.modelToCanonical));
      return;
    }
    for (const issue of callIssues) {
      matchedIssues.add(issue);
    }
    const primaryIssue = pickPrimaryIssue(callIssues);
    const recovered = repairSingleIssue(message, primaryIssue, rawCall, maps);
    if (recovered.kind === "repaired") {
      repaired.push(...recovered.calls);
      return;
    }
    unresolved.push(primaryIssue);
    feedback.push({ toolCallId: primaryIssue.id, content: recovered.feedback });
  });

  // Issues that did not map onto a raw call by position (e.g. content-only
  // missing_function / missing_name promotion) are handled from the message body.
  for (const issue of issues) {
    if (matchedIssues.has(issue)) {
      continue;
    }
    const recovered = repairSingleIssue(message, issue, undefined, maps);
    if (recovered.kind === "repaired") {
      repaired.push(...recovered.calls);
      continue;
    }
    unresolved.push(issue);
    feedback.push({ toolCallId: issue.id, content: recovered.feedback });
  }

  return { repaired, feedback, unresolved };
}

/**
 * Map each issue onto the index of its raw tool call. inspect assigns a fresh
 * synthetic id to id-less calls (different from the one readToolCalls would
 * pick), so we cannot match by id; instead we re-derive the issue kind from the
 * raw call at each position and pair them up in order. This keeps the
 * passthrough/repair partition exact even when the provider omits ids.
 */
function groupIssuesByPosition(
  rawToolCalls: Array<Record<string, unknown>>,
  issues: ToolCallProtocolIssue[],
): Map<number, ToolCallProtocolIssue[]> {
  const grouped = new Map<number, ToolCallProtocolIssue[]>();
  // Fast path: when every issue id matches a raw call id, trust the id linkage.
  const byId = new Map<string, number>();
  rawToolCalls.forEach((rawCall, index) => {
    if (rawCall && typeof rawCall === "object" && typeof rawCall.id === "string" && rawCall.id.trim()) {
      byId.set(rawCall.id, index);
    }
  });
  for (const issue of issues) {
    const index = byId.get(issue.id);
    if (index !== undefined) {
      appendToGroup(grouped, index, issue);
    }
  }
  if (grouped.size > 0 || issues.length === 0) {
    return grouped;
  }
  // Fallback (id-less raw calls): pair issues to positions by recomputing the
  // kind each raw call would produce, consuming positions left-to-right.
  const used = new Set<number>();
  for (const issue of issues) {
    for (let index = 0; index < rawToolCalls.length; index += 1) {
      if (used.has(index)) {
        continue;
      }
      if (rawCallProducesIssueKind(rawToolCalls[index]!, issue.kind)) {
        appendToGroup(grouped, index, issue);
        used.add(index);
        break;
      }
    }
  }
  return grouped;
}

function appendToGroup(
  grouped: Map<number, ToolCallProtocolIssue[]>,
  index: number,
  issue: ToolCallProtocolIssue,
): void {
  const existing = grouped.get(index);
  if (existing) {
    existing.push(issue);
  } else {
    grouped.set(index, [issue]);
  }
}

/** Best-effort check: would this raw call surface the given issue kind? */
function rawCallProducesIssueKind(rawCall: Record<string, unknown>, kind: ToolCallProtocolIssue["kind"]): boolean {
  const fn = readFunctionPayload(rawCall);
  switch (kind) {
    case "missing_function":
      return !fn;
    case "missing_name":
      return Boolean(fn) && (typeof fn?.name !== "string" || !fn.name.trim());
    default:
      return Boolean(fn) && typeof fn?.name === "string" && fn.name.trim().length > 0;
  }
}

/**
 * When a raw call carries several issues, repair from the most actionable one.
 * A bad name dominates: fixing it lets repairUnsupportedName re-salvage the
 * arguments in the same pass, so we never need a separate args repair.
 */
function pickPrimaryIssue(callIssues: ToolCallProtocolIssue[]): ToolCallProtocolIssue {
  return (
    callIssues.find((issue) => issue.kind === "missing_function") ??
    callIssues.find((issue) => issue.kind === "missing_name") ??
    callIssues.find((issue) => issue.kind === "unsupported_name") ??
    callIssues[0]!
  );
}

/** Parse one already-clean raw tool call into an executable ParsedToolCall. */
function readSingleCleanCall(
  rawCall: Record<string, unknown>,
  modelToCanonical: Map<string, string>,
): ParsedToolCall[] {
  return readToolCalls({ tool_calls: [rawCall] }, modelToCanonical);
}

type SingleIssueRepair =
  | { readonly kind: "repaired"; readonly calls: ParsedToolCall[] }
  | { readonly kind: "feedback"; readonly feedback: string };

function repairSingleIssue(
  message: Record<string, unknown>,
  issue: ToolCallProtocolIssue,
  rawCall: Record<string, unknown> | undefined,
  maps: ToolCallRepairMaps,
): SingleIssueRepair {
  switch (issue.kind) {
    case "unsupported_name":
      return repairUnsupportedName(issue, rawCall, maps);
    case "malformed_arguments":
      return repairMalformedArguments(issue, rawCall, maps);
    case "non_object_arguments":
      return repairNonObjectArguments(issue, rawCall, maps);
    case "missing_function":
    case "missing_name":
      return repairFromSerializedBody(message, issue, maps);
    default:
      return { kind: "feedback", feedback: buildUnknownIssueFeedback(issue, maps) };
  }
}

// --- unsupported_name -------------------------------------------------------

function repairUnsupportedName(
  issue: ToolCallProtocolIssue,
  rawCall: Record<string, unknown> | undefined,
  maps: ToolCallRepairMaps,
): SingleIssueRepair {
  const rawName = issue.rawName ?? "";
  const canonical = fuzzyResolveAllowedToolName(rawName, maps.modelToCanonical);
  if (!canonical) {
    return { kind: "feedback", feedback: buildUnsupportedNameFeedback(rawName, maps) };
  }
  // Re-derive args from the raw payload using the *now-resolved* name so a
  // simultaneously-malformed argument string is salvaged in the same pass.
  const fn = readFunctionPayload(rawCall);
  const { args, rawArguments } = salvageArguments(typeof fn?.arguments === "string" ? fn.arguments : undefined);
  return {
    kind: "repaired",
    calls: [{ id: issue.id, toolName: canonical, args, rawArguments }],
  };
}

// --- malformed_arguments ----------------------------------------------------

function repairMalformedArguments(
  issue: ToolCallProtocolIssue,
  rawCall: Record<string, unknown> | undefined,
  maps: ToolCallRepairMaps,
): SingleIssueRepair {
  const rawName = issue.rawName ?? "";
  const canonical = resolveAllowedModelToolCallName(rawName, maps.modelToCanonical);
  if (!canonical) {
    // A malformed-args call whose name is also unsupported: surface the name
    // problem (the more actionable correction) instead of guessing.
    return { kind: "feedback", feedback: buildUnsupportedNameFeedback(rawName, maps) };
  }
  const fn = readFunctionPayload(rawCall);
  const rawArgs = typeof fn?.arguments === "string" ? fn.arguments : "";
  const salvaged = salvageJsonObject(rawArgs);
  if (!salvaged) {
    return { kind: "feedback", feedback: buildMalformedArgumentsFeedback(canonical) };
  }
  return {
    kind: "repaired",
    calls: [{ id: issue.id, toolName: canonical, args: salvaged, rawArguments: JSON.stringify(salvaged) }],
  };
}

// --- non_object_arguments ---------------------------------------------------

function repairNonObjectArguments(
  issue: ToolCallProtocolIssue,
  rawCall: Record<string, unknown> | undefined,
  maps: ToolCallRepairMaps,
): SingleIssueRepair {
  const rawName = issue.rawName ?? "";
  const canonical = resolveAllowedModelToolCallName(rawName, maps.modelToCanonical);
  if (!canonical) {
    return { kind: "feedback", feedback: buildUnsupportedNameFeedback(rawName, maps) };
  }
  const fn = readFunctionPayload(rawCall);
  const rawArgs = typeof fn?.arguments === "string" ? fn.arguments : "";
  const unwrapped = unwrapSingleObjectArray(rawArgs);
  if (!unwrapped) {
    return { kind: "feedback", feedback: buildNonObjectArgumentsFeedback(canonical) };
  }
  return {
    kind: "repaired",
    calls: [{ id: issue.id, toolName: canonical, args: unwrapped, rawArguments: JSON.stringify(unwrapped) }],
  };
}

// --- missing_function / missing_name (prose / XML body) ---------------------

function repairFromSerializedBody(
  message: Record<string, unknown>,
  issue: ToolCallProtocolIssue,
  maps: ToolCallRepairMaps,
): SingleIssueRepair {
  const body = extractMessageContent(message);
  // parseSerializedToolCalls already fails closed: every recovered call passed
  // through resolveAllowedModelToolCallName, so the tool surface stays fixed.
  const promoted = parseSerializedToolCalls(body, maps.modelToCanonical);
  if (promoted.length === 0) {
    return { kind: "feedback", feedback: buildMissingNameFeedback(maps) };
  }
  return { kind: "repaired", calls: promoted };
}

// --- argument salvage helpers ----------------------------------------------

function salvageArguments(rawArgs: string | undefined): { args: Record<string, unknown>; rawArguments: string } {
  if (!rawArgs || !rawArgs.trim()) {
    return { args: {}, rawArguments: "{}" };
  }
  const salvaged = salvageJsonObject(rawArgs);
  if (salvaged) {
    return { args: salvaged, rawArguments: JSON.stringify(salvaged) };
  }
  const unwrapped = unwrapSingleObjectArray(rawArgs);
  if (unwrapped) {
    return { args: unwrapped, rawArguments: JSON.stringify(unwrapped) };
  }
  return { args: {}, rawArguments: "{}" };
}

/**
 * JSON salvage for malformed argument strings:
 *  1. strip ``` / ```json code fences,
 *  2. normalize smart / Unicode quotes to ASCII,
 *  3. extract the first balanced {...} object,
 *  4. remove trailing commas,
 *  5. JSON.parse.
 * Returns the parsed object, or undefined if nothing usable could be recovered.
 */
export function salvageJsonObject(raw: string): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const defenced = stripCodeFences(raw);
  const normalizedQuotes = normalizeQuotes(defenced);
  const balanced = extractFirstBalancedObject(normalizedQuotes);
  if (!balanced) {
    return undefined;
  }
  const withoutTrailingCommas = removeTrailingCommas(balanced);
  try {
    const parsed = JSON.parse(withoutTrailingCommas) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** If the args are a one-element array wrapping a single object, unwrap it. */
export function unwrapSingleObjectArray(raw: string): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Tolerate the array itself being lightly malformed (fences/quotes/commas).
    const normalized = removeTrailingCommas(normalizeQuotes(stripCodeFences(raw)));
    try {
      parsed = JSON.parse(normalized) as unknown;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(parsed) && parsed.length === 1) {
    const [only] = parsed;
    if (only && typeof only === "object" && !Array.isArray(only)) {
      return only as Record<string, unknown>;
    }
  }
  return undefined;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json|js|javascript)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenceMatch && typeof fenceMatch[1] === "string") {
    return fenceMatch[1].trim();
  }
  // Inline / unterminated fences: drop any backtick fence markers we can see.
  return trimmed.replace(/```(?:json|js|javascript)?/gi, "").replace(/```/g, "").trim();
}

function normalizeQuotes(raw: string): string {
  return raw
    .replace(/[“”„‟″‶]/g, '"')
    .replace(/[‘’‚‛′‵]/g, "'");
}

/**
 * Walk the string and return the first brace-balanced {...} span, ignoring
 * braces that appear inside JSON string literals. Returns undefined if no
 * balanced object is present.
 */
export function extractFirstBalancedObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function removeTrailingCommas(raw: string): string {
  // Remove commas that directly precede a closing } or ] (ignoring whitespace).
  return raw.replace(/,(\s*[}\]])/g, "$1");
}

// --- fuzzy name resolution --------------------------------------------------

/**
 * Resolve an emitted tool name onto an allowed name, tolerating transcription
 * slips. Stages, each gated by {@link resolveAllowedModelToolCallName} so the
 * tool surface is never widened:
 *  1. exact (allowed as-is),
 *  2. case-insensitive + separator-normalized ([_.-] collapsed),
 *  3. bounded Levenshtein (<= MAX_NAME_EDIT_DISTANCE) against allowed keys.
 * Returns the canonical name, or undefined on a miss (fail-closed).
 */
export function fuzzyResolveAllowedToolName(
  rawName: string,
  modelToCanonical: Map<string, string>,
): string | undefined {
  if (typeof rawName !== "string" || !rawName.trim()) {
    return undefined;
  }
  // Empty registry -> fail closed before any matching work.
  if (modelToCanonical.size === 0) {
    return undefined;
  }
  const exact = resolveAllowedModelToolCallName(rawName, modelToCanonical);
  if (exact) {
    return exact;
  }

  const candidateKeys = collectAllowedNameKeys(modelToCanonical);
  const target = normalizeNameForMatch(rawName);

  // Stage 2: case-insensitive, separator-normalized exact match.
  for (const key of candidateKeys) {
    if (normalizeNameForMatch(key) === target) {
      const resolved = resolveAllowedModelToolCallName(key, modelToCanonical);
      if (resolved) {
        return resolved;
      }
    }
  }

  // Stage 3: bounded Levenshtein on the normalized forms. Pick the closest, and
  // require a strict single winner so an ambiguous fuzz never silently binds.
  let best: { key: string; distance: number } | undefined;
  let bestIsTied = false;
  for (const key of candidateKeys) {
    const distance = boundedLevenshtein(target, normalizeNameForMatch(key), MAX_NAME_EDIT_DISTANCE);
    if (distance > MAX_NAME_EDIT_DISTANCE) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { key, distance };
      bestIsTied = false;
    } else if (distance === best.distance) {
      bestIsTied = true;
    }
  }
  if (best && !bestIsTied) {
    return resolveAllowedModelToolCallName(best.key, modelToCanonical);
  }
  return undefined;
}

function collectAllowedNameKeys(modelToCanonical: Map<string, string>): string[] {
  const keys = new Set<string>();
  for (const [modelName, canonicalName] of modelToCanonical.entries()) {
    keys.add(modelName);
    keys.add(canonicalName);
  }
  return [...keys];
}

function normalizeNameForMatch(name: string): string {
  return name.toLowerCase().replace(/[_.-]+/g, "");
}

/**
 * Levenshtein edit distance, short-circuited once the running minimum exceeds
 * `max` (returns max + 1). Bounded to keep the per-candidate cost trivial.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) {
    return 0;
  }
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let column = 0; column <= b.length; column += 1) {
    previous[column] = column;
  }
  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    let rowMin = current[0]!;
    for (let column = 1; column <= b.length; column += 1) {
      const substitutionCost = a[row - 1] === b[column - 1] ? 0 : 1;
      const value = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + substitutionCost,
      );
      current[column] = value;
      if (value < rowMin) {
        rowMin = value;
      }
    }
    if (rowMin > max) {
      return max + 1;
    }
    for (let column = 0; column <= b.length; column += 1) {
      previous[column] = current[column]!;
    }
  }
  return previous[b.length]!;
}

// --- raw-call access --------------------------------------------------------

function readFunctionPayload(rawCall: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!rawCall) {
    return undefined;
  }
  return rawCall.function && typeof rawCall.function === "object"
    ? (rawCall.function as Record<string, unknown>)
    : undefined;
}

// --- feedback builders ------------------------------------------------------

function listAllowedToolNames(maps: ToolCallRepairMaps): string[] {
  const names = new Set<string>(maps.canonicalToModel.keys());
  if (names.size === 0) {
    for (const canonical of maps.modelToCanonical.values()) {
      names.add(canonical);
    }
  }
  return [...names].sort();
}

function describeAllowedTools(maps: ToolCallRepairMaps): string {
  const names = listAllowedToolNames(maps);
  if (names.length === 0) {
    return "No tools are available for this turn; answer directly without calling a tool.";
  }
  return `Valid tools for this turn: ${names.join(", ")}.`;
}

function buildUnsupportedNameFeedback(rawName: string, maps: ToolCallRepairMaps): string {
  return JSON.stringify({
    error: "unsupported_tool",
    requested: rawName,
    detail: `The tool ${JSON.stringify(rawName)} is not available. ${describeAllowedTools(maps)}`,
  });
}

function buildMalformedArgumentsFeedback(toolName: string): string {
  return JSON.stringify({
    error: "malformed_arguments",
    tool: toolName,
    detail: `Arguments for ${JSON.stringify(toolName)} were not valid JSON. Re-issue the call with a single JSON object of arguments.`,
  });
}

function buildNonObjectArgumentsFeedback(toolName: string): string {
  return JSON.stringify({
    error: "non_object_arguments",
    tool: toolName,
    detail: `Arguments for ${JSON.stringify(toolName)} must be a JSON object, not an array or scalar. Re-issue the call with a single JSON object.`,
  });
}

function buildMissingNameFeedback(maps: ToolCallRepairMaps): string {
  return JSON.stringify({
    error: "missing_tool_name",
    detail: `A tool call was emitted without a usable function name. ${describeAllowedTools(maps)}`,
  });
}

function buildUnknownIssueFeedback(issue: ToolCallProtocolIssue, maps: ToolCallRepairMaps): string {
  return JSON.stringify({
    error: "tool_call_protocol",
    detail: `${issue.detail} ${describeAllowedTools(maps)}`,
  });
}
