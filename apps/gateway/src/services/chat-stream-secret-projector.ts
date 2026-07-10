import { redactSecretText, type ChatStreamChunk, type ChatStreamChunkDraft } from "@goatcitadel/contracts";
import { projectChatStreamChunkForPublic } from "./chat-secret-projection.js";

export const CHAT_STREAM_SECRET_PROJECTION_VERSION = 1;
export const CHAT_STREAM_SECRET_PROJECTION_VERSION_FIELD = "__publicSecretProjectionVersion";

interface StreamTextProjectionState {
  pending: string;
  suppressUntilTerminal: boolean;
  suppressed: boolean;
  sessionId: string;
  turnId: string;
  type: "delta" | "thinking_delta";
  order: number;
}

type ProjectableChatStreamChunk = ChatStreamChunk | ChatStreamChunkDraft;

// Keeping this below a typical provider token batch bounds both memory and the
// repeated lexical scans. Once crossed, live text fails closed until the
// authoritative terminal content arrives.
const MAX_UNDECIDED_STREAM_SUFFIX_CHARS = 512;

/**
 * Holds only the undecided lexical suffix so provider chunk boundaries cannot
 * split a credential pattern into independently-safe fragments. Completed safe
 * words/statements are projected once and released; open credential quotes and
 * Authorization lines remain buffered through their logical delimiter. The
 * final message_done remains the authoritative complete projected content.
 */
export class ChatStreamSecretProjector {
  private readonly textStates = new Map<string, StreamTextProjectionState>();
  private readonly suppressTextTurns = new Set<string>();
  private nextStateOrder = 0;

  public beginTurn(turnId: string, options: { suppressTextUntilTerminal?: boolean } = {}): void {
    this.resetTurn(turnId);
    if (options.suppressTextUntilTerminal) {
      this.suppressTextTurns.add(turnId);
    }
  }

  public project<T extends ProjectableChatStreamChunk>(chunk: T): T {
    const projected = this.projectAll(chunk);
    return projected[projected.length - 1] as T;
  }

  /**
   * Projects a chunk and returns any safe thinking tail immediately before a
   * terminal chunk. Thinking has no full-content terminal of its own, so this
   * preserves its final token without weakening split-secret containment.
   */
  public projectAll(chunk: ProjectableChatStreamChunk): ProjectableChatStreamChunk[] {
    if (chunk.type === "delta" || chunk.type === "thinking_delta") {
      return [this.projectTextChunk(chunk)];
    }

    const projected = projectChatStreamChunkForPublic(chunk);
    const pendingText =
      (chunk.type === "message_done" || chunk.type === "done" || chunk.type === "error") &&
      typeof chunk.turnId === "string"
        ? this.drainPendingText(chunk.turnId, chunk.type !== "message_done")
        : [];
    if (
      (chunk.type === "message_done" || chunk.type === "done" || chunk.type === "error") &&
      typeof chunk.turnId === "string"
    ) {
      this.resetTurn(chunk.turnId);
    }
    return [...pendingText, projected];
  }

  public flushTurn(turnId: string): ChatStreamChunkDraft[] {
    const pending = this.drainPendingText(turnId, true);
    this.resetTurn(turnId);
    return pending;
  }

  public resetTurn(turnId: string): void {
    this.suppressTextTurns.delete(turnId);
    const prefix = `${turnId}\u0000`;
    for (const key of this.textStates.keys()) {
      if (key.startsWith(prefix)) {
        this.textStates.delete(key);
      }
    }
  }

  private projectTextChunk<T extends ChatStreamChunk | ChatStreamChunkDraft>(chunk: T): T {
    if (chunk.type !== "delta" && chunk.type !== "thinking_delta") {
      return chunk;
    }
    const key = `${chunk.turnId}\u0000${chunk.type}`;
    const state = this.textStates.get(key) ?? {
      pending: "",
      suppressUntilTerminal: this.suppressTextTurns.has(chunk.turnId),
      suppressed: this.suppressTextTurns.has(chunk.turnId),
      sessionId: chunk.sessionId,
      turnId: chunk.turnId,
      type: chunk.type,
      order: this.nextStateOrder,
    };
    if (!this.textStates.has(key)) {
      this.nextStateOrder += 1;
    }
    state.sessionId = chunk.sessionId;

    if (!state.suppressUntilTerminal) {
      state.pending += chunk.delta;
      if (state.pending.length > MAX_UNDECIDED_STREAM_SUFFIX_CHARS) {
        state.pending = "";
        state.suppressUntilTerminal = true;
        state.suppressed = true;
      }
    }

    let delta = "";
    if (!state.suppressUntilTerminal) {
      const unsafeSuffixStart = findUnsafeStreamingSuffixStart(state.pending);
      const decisionLimit = unsafeSuffixStart >= 0 ? unsafeSuffixStart : state.pending.length;
      const safeBoundary = lastSafeDelimiterEnd(state.pending, decisionLimit);
      if (safeBoundary > 0) {
        const rawPrefix = state.pending.slice(0, safeBoundary);
        if (findUnsafeStreamingSuffixStart(rawPrefix) < 0) {
          if (canBypassCanonicalStreamRedaction(rawPrefix)) {
            delta = rawPrefix;
          } else {
            const projectedPrefix = projectChatStreamChunkForPublic({ ...chunk, delta: rawPrefix });
            delta =
              projectedPrefix.type === "delta" || projectedPrefix.type === "thinking_delta"
                ? projectedPrefix.delta
                : redactSecretText(rawPrefix).value;
          }
          state.pending = state.pending.slice(safeBoundary);
        }
      }
    }
    this.textStates.set(key, state);
    return { ...chunk, delta } as T;
  }

  private drainPendingText(turnId: string, includeAssistantDelta: boolean): ChatStreamChunkDraft[] {
    const prefix = `${turnId}\u0000`;
    const states = [...this.textStates.entries()]
      .filter(([key, state]) => key.startsWith(prefix) && (includeAssistantDelta || state.type === "thinking_delta"))
      .sort((left, right) => left[1].order - right[1].order);
    const chunks: ChatStreamChunkDraft[] = [];
    for (const [key, state] of states) {
      this.textStates.delete(key);
      const delta = state.suppressed ? "[REDACTED]" : redactSecretText(state.pending).value;
      if (!delta) {
        continue;
      }
      chunks.push({
        type: state.type,
        sessionId: state.sessionId,
        turnId: state.turnId,
        delta,
      });
    }
    return chunks;
  }
}

function canBypassCanonicalStreamRedaction(value: string): boolean {
  if (
    !value ||
    /["'`:=@\\/$%?&{}<>_-]/.test(value) ||
    value.includes("[") ||
    value.includes("]") ||
    /[A-Za-z0-9+/]{16,}/.test(value) ||
    /\b(?:gca|grat|github|glpat|npm|hf|AKIA|xox)[A-Za-z0-9_-]*/i.test(value)
  ) {
    return false;
  }
  for (const match of value.matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
    if (isStreamingCredentialLabel(match[0])) {
      return false;
    }
  }
  return true;
}

function lastSafeDelimiterEnd(value: string, limit: number): number {
  for (let index = Math.min(limit, value.length) - 1; index >= 0; index -= 1) {
    if (/[\s;,)}\]]/.test(value[index] ?? "")) {
      return index + 1;
    }
  }
  return 0;
}

function findUnsafeStreamingSuffixStart(value: string): number {
  let unsafeStart = value.length;
  const markUnsafe = (start: number): void => {
    unsafeStart = Math.min(unsafeStart, start);
  };

  const headerPattern = /\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:/gi;
  for (let match = headerPattern.exec(value); match; match = headerPattern.exec(value)) {
    if (
      /^(?:Authorization|Proxy-Authorization)/i.test(match[0] ?? "") &&
      looksLikeCompletedAuthorizationCode(value.slice(match.index))
    ) {
      continue;
    }
    if (!hasCompleteLogicalHeader(value, match.index + match[0].length)) {
      markUnsafe(match.index);
    }
  }

  const assignmentPattern = /(\\?["']?)\b([A-Za-z_$][A-Za-z0-9_$-]*)\b(?:\\?["'])?\s*(?::=|:|(?<![=!<>])=(?!=|>))\s*/gi;
  for (let match = assignmentPattern.exec(value); match; match = assignmentPattern.exec(value)) {
    const label = match[2] ?? "";
    if (!isStreamingCredentialLabel(label)) {
      continue;
    }
    const valueStart = match.index + match[0].length;
    const separatorIndex = match[0].indexOf(":");
    if (
      separatorIndex >= 0 &&
      isIncompleteYamlIndentedCredentialBlock(value, match.index + separatorIndex + 1, valueStart)
    ) {
      markUnsafe(match.index);
      continue;
    }
    if (isIncompleteYamlCredentialBlock(value, valueStart)) {
      markUnsafe(match.index);
      continue;
    }
    if (!hasCompleteCredentialValue(value, valueStart)) {
      markUnsafe(match.index);
    }
  }

  const typedInitializerPattern = /\b([A-Za-z_$][A-Za-z0-9_$-]*)\s*:\s*([^=;{}\r\n]+?)\s*=\s*/gi;
  for (let match = typedInitializerPattern.exec(value); match; match = typedInitializerPattern.exec(value)) {
    if (
      isStreamingCredentialLabel(match[1] ?? "") &&
      looksLikeStreamingTypeExpression(match[2] ?? "") &&
      !hasCompleteCredentialValue(value, match.index + match[0].length)
    ) {
      markUnsafe(match.index);
    }
  }

  const trailingTypedDeclaration = /\b([A-Za-z_$][A-Za-z0-9_$-]*)\s*:\s*([^=;{}\r\n]+?)\s+$/i.exec(value);
  if (
    trailingTypedDeclaration &&
    isStreamingCredentialLabel(trailingTypedDeclaration[1] ?? "") &&
    looksLikeStreamingTypeExpression(trailingTypedDeclaration[2] ?? "")
  ) {
    markUnsafe(trailingTypedDeclaration.index);
  }

  const standaloneAuthorization = /\b(?:Bearer|Basic)\s+/gi;
  for (let match = standaloneAuthorization.exec(value); match; match = standaloneAuthorization.exec(value)) {
    const valueStart = match.index + match[0].length;
    if (!hasCompleteUnquotedValue(value, valueStart)) {
      markUnsafe(match.index);
    }
  }

  const cliPattern = /(?:^|[ \t\r\n])-{1,2}([A-Za-z][A-Za-z0-9_-]*)[ \t]+/gi;
  for (let match = cliPattern.exec(value); match; match = cliPattern.exec(value)) {
    if (!isStreamingExecutableSecretLabel(match[1] ?? "")) {
      continue;
    }
    if (!hasCompleteCredentialValue(value, match.index + match[0].length)) {
      markUnsafe(match.index);
    }
  }

  const argvPattern = /(["'])(-{1,2}([A-Za-z][A-Za-z0-9_-]*))\1\s*,\s*(["'`])/gi;
  for (let match = argvPattern.exec(value); match; match = argvPattern.exec(value)) {
    if (!isStreamingExecutableSecretLabel(match[3] ?? "")) {
      continue;
    }
    const quote = match[4] ?? "";
    if (!hasClosingCredentialQuote(value, match.index + match[0].length, quote, false)) {
      markUnsafe(match.index);
    }
  }

  const authArgvSchemePattern = /(["'])(-{1,2}([A-Za-z][A-Za-z0-9_-]*))\1\s*,\s*(["'`])(?:Bearer|Basic)\4/gi;
  for (let match = authArgvSchemePattern.exec(value); match; match = authArgvSchemePattern.exec(value)) {
    if (!isStreamingAuthorizationCredentialLabel(match[3] ?? "")) {
      continue;
    }
    const remainderStart = match.index + match[0].length;
    const nextValue = /^\s*,\s*(["'`])/.exec(value.slice(remainderStart));
    if (
      !nextValue ||
      !hasClosingCredentialQuote(value, remainderStart + nextValue[0].length, nextValue[1] ?? "", false)
    ) {
      markUnsafe(match.index);
    }
  }

  const trailingArgvPrefix = /(["'])(-{1,2}([A-Za-z][A-Za-z0-9_-]*))\1\s*,\s*["'`]?$/i.exec(value);
  if (trailingArgvPrefix && isStreamingExecutableSecretLabel(trailingArgvPrefix[3] ?? "")) {
    markUnsafe(trailingArgvPrefix.index);
  }

  const trailingLabel = /(\\?["']?)([A-Za-z_$][A-Za-z0-9_$-]*)(?:\\?["'])?\s*$/i.exec(value);
  if (trailingLabel && isStreamingCredentialLabel(trailingLabel[2] ?? "")) {
    markUnsafe(trailingLabel.index);
  }

  const trailingFlag = /-{1,2}([A-Za-z][A-Za-z0-9_-]*)[ \t]*$/i.exec(value);
  if (trailingFlag && isStreamingExecutableSecretLabel(trailingFlag[1] ?? "")) {
    markUnsafe(trailingFlag.index);
  }

  return unsafeStart < value.length ? unsafeStart : -1;
}

function isStreamingCredentialLabel(label: string): boolean {
  const normalized = normalizeStreamingCredentialLabel(label);
  return (
    /(?:^|_)WEBHOOK_(?:URL|URI|ENDPOINT)(?:_|$)/.test(normalized) ||
    /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|BEARER|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN)(?:_|$)/.test(
      normalized,
    ) ||
    /(?:^|_)(?:API|ACCESS|CLIENT|CONSUMER|PRIVATE|SECRET|SIGNING)_KEY(?:_|$)/.test(normalized)
  );
}

function normalizeStreamingCredentialLabel(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function isStreamingExecutableSecretLabel(label: string): boolean {
  if (!isStreamingCredentialLabel(label)) {
    return false;
  }
  return !/_(?:ALGORITHM|CONFIGURED|CONTEXT|COUNT|COUNTS|ENABLED|ENV|ENVS|ENV_NAME|HEADER_NAME|ID|IDS|KIND|METHOD|MODE|NAME|POLICY|PRESENT|PROFILE|READINESS|REF|REFS|REFERENCE|REFERENCES|REQUIRED|REQUIREMENTS|SCHEME|SOURCE|STATE|STATUS|SUPPORTED|TYPE)$/.test(
    normalizeStreamingCredentialLabel(label),
  );
}

function isStreamingAuthorizationCredentialLabel(label: string): boolean {
  return /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|BEARER)(?:_|$)/.test(normalizeStreamingCredentialLabel(label));
}

function looksLikeStreamingTypeExpression(value: string): boolean {
  const candidate = value.trim();
  return (
    /^(?:any|bigint|boolean|never|number|object|string|str|symbol|unknown|void|String\??|&str)$/i.test(candidate) ||
    /^(?:typeof\s+)?[A-Z][A-Za-z0-9_$.]*(?:<[^\r\n;{}]+>)?\??$/.test(candidate) ||
    /^(?:typeof\s+|[a-z_$][A-Za-z0-9_$.]*<|\()/.test(candidate)
  );
}

function hasCompleteLogicalHeader(value: string, contentStart: number): boolean {
  let lineEnd = findLineEnd(value, contentStart);
  if (lineEnd < 0) {
    return false;
  }
  while (lineEnd < value.length) {
    const nextLineStart = value[lineEnd] === "\r" && value[lineEnd + 1] === "\n" ? lineEnd + 2 : lineEnd + 1;
    if (nextLineStart >= value.length) {
      return false;
    }
    if (value[nextLineStart] !== " " && value[nextLineStart] !== "\t") {
      return true;
    }
    lineEnd = findLineEnd(value, nextLineStart);
    if (lineEnd < 0) {
      return false;
    }
  }
  return true;
}

function findLineEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "\r" || value[index] === "\n") {
      return index;
    }
  }
  return -1;
}

function looksLikeCompletedAuthorizationCode(value: string): boolean {
  const lineEnd = findLineEnd(value, 0);
  const line = value.slice(0, lineEnd < 0 ? value.length : lineEnd);
  const separator = line.indexOf(":");
  if (separator < 0) {
    return false;
  }
  const assigned = line.slice(separator + 1).trim();
  return (
    /^(?:any|bigint|boolean|never|number|object|string|str|symbol|unknown|void|String\??|&str|(?:typeof\s+)?[A-Za-z_$][A-Za-z0-9_$.]*(?:<[^;{}]+>)?\??)(?:\s*=\s*(?:[A-Za-z_$][A-Za-z0-9_$.]*|null|undefined|["'`].*["'`]))?\s*[,;)}].*$/.test(
      assigned,
    ) ||
    /^`(?:Bearer|Basic)\s+\$\{[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\}`\s*[,;}].*$/i.test(assigned)
  );
}

function hasCompleteCredentialValue(value: string, valueStart: number): boolean {
  if (valueStart >= value.length) {
    return false;
  }
  const first = value[valueStart] ?? "";
  const prefixedLiteral = /^[rubf]{1,2}(["'])/i.exec(value.slice(valueStart));
  if (prefixedLiteral) {
    const quote = prefixedLiteral[1] ?? "";
    return hasClosingCredentialQuote(value, valueStart + prefixedLiteral[0].length, quote, false);
  }
  if (first === "[" || first === "{") {
    return hasClosingCollectionDelimiter(value, valueStart, first === "[" ? "]" : "}");
  }
  if (first === "!" || first === "&") {
    const directiveEnd = value.slice(valueStart).search(/\s/);
    if (directiveEnd < 0) {
      return false;
    }
    return hasCompleteUnquotedValue(value, valueStart + directiveEnd);
  }
  const callPrefix = /^(?:await\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*)*!?\s*\(/.exec(
    value.slice(valueStart),
  );
  if (callPrefix) {
    const openParen = valueStart + callPrefix[0].lastIndexOf("(");
    return findClosingBalancedDelimiter(value, openParen, "(", ")") >= 0;
  }
  if (first === "\\" && /["'`]/.test(value[valueStart + 1] ?? "")) {
    const quote = value[valueStart + 1] ?? "";
    return hasClosingCredentialQuote(value, valueStart + 2, quote, true);
  }
  if (/["'`]/.test(first)) {
    return hasClosingCredentialQuote(value, valueStart + 1, first, false);
  }
  return hasCompleteUnquotedValue(value, valueStart);
}

function hasClosingCollectionDelimiter(value: string, valueStart: number, expectedClose: string): boolean {
  return findClosingBalancedDelimiter(value, valueStart, value[valueStart] ?? "", expectedClose) >= 0;
}

function findClosingBalancedDelimiter(
  value: string,
  valueStart: number,
  expectedOpen: string,
  expectedClose: string,
): number {
  let quote = "";
  let escaped = false;
  let depth = 1;
  for (let index = valueStart + 1; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === expectedOpen) {
      depth += 1;
    } else if (character === expectedClose) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function isIncompleteYamlIndentedCredentialBlock(
  value: string,
  separatorEnd: number,
  parsedValueStart: number,
): boolean {
  const firstLineEnd = findLineEnd(value, separatorEnd);
  if (firstLineEnd < 0 || firstLineEnd >= parsedValueStart) {
    return false;
  }
  let lineStart =
    value[firstLineEnd] === "\r" && value[firstLineEnd + 1] === "\n" ? firstLineEnd + 2 : firstLineEnd + 1;
  let sawIndentedLine = false;
  while (lineStart < value.length) {
    if (value[lineStart] === "\r" || value[lineStart] === "\n") {
      lineStart = value[lineStart] === "\r" && value[lineStart + 1] === "\n" ? lineStart + 2 : lineStart + 1;
      continue;
    }
    if (value[lineStart] !== " " && value[lineStart] !== "\t") {
      return false;
    }
    sawIndentedLine = true;
    const lineEnd = findLineEnd(value, lineStart);
    if (lineEnd < 0) {
      return true;
    }
    lineStart = value[lineEnd] === "\r" && value[lineEnd + 1] === "\n" ? lineEnd + 2 : lineEnd + 1;
  }
  return sawIndentedLine;
}

function hasCompleteUnquotedValue(value: string, valueStart: number): boolean {
  let index = valueStart;
  while (index < value.length && /\s/.test(value[index] ?? "")) {
    index += 1;
  }
  if (index >= value.length) {
    return false;
  }
  for (; index < value.length; index += 1) {
    if (/[\s,;)}\]]/.test(value[index] ?? "")) {
      return true;
    }
  }
  return false;
}

function isIncompleteYamlCredentialBlock(value: string, valueStart: number): boolean {
  if (!/[|>]/.test(value[valueStart] ?? "")) {
    return false;
  }
  const indicatorLineEnd = findLineEnd(value, valueStart);
  if (indicatorLineEnd < 0) {
    return true;
  }
  let lineStart =
    value[indicatorLineEnd] === "\r" && value[indicatorLineEnd + 1] === "\n"
      ? indicatorLineEnd + 2
      : indicatorLineEnd + 1;
  let sawIndentedLine = false;
  while (lineStart < value.length) {
    if (value[lineStart] === "\r" || value[lineStart] === "\n") {
      lineStart = value[lineStart] === "\r" && value[lineStart + 1] === "\n" ? lineStart + 2 : lineStart + 1;
      continue;
    }
    if (value[lineStart] !== " " && value[lineStart] !== "\t") {
      return !sawIndentedLine;
    }
    sawIndentedLine = true;
    const lineEnd = findLineEnd(value, lineStart);
    if (lineEnd < 0) {
      return true;
    }
    lineStart = value[lineEnd] === "\r" && value[lineEnd + 1] === "\n" ? lineEnd + 2 : lineEnd + 1;
  }
  return true;
}

function hasClosingCredentialQuote(
  value: string,
  valueStart: number,
  quote: string,
  delimiterEscaped: boolean,
): boolean {
  for (let index = valueStart; index < value.length; index += 1) {
    if (value[index] !== quote) {
      continue;
    }
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= valueStart && value[cursor] === "\\"; cursor -= 1) {
      slashCount += 1;
    }
    if ((!delimiterEscaped && slashCount % 2 === 0) || (delimiterEscaped && slashCount % 2 === 1)) {
      return true;
    }
  }
  return false;
}
