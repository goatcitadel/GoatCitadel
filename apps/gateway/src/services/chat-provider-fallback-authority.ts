import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import type { LlmService } from "./llm-service.js";
import { LlmDispatchGuardRejectedError, type LlmDispatchGuard } from "./llm-dispatch-guard.js";

const AUTHORIZATION = Symbol("chat-provider-fallback-authorization");
const REQUIRED = Symbol("chat-provider-fallback-required");
const issued = new WeakMap<ChatProviderFallbackAuthorization, AuthorityState>();

export interface ChatProviderFallbackAuthorization {
  readonly kind: "server_chat_provider_fallback";
}

interface Route {
  providerId: string;
  model: string;
}
interface AuthorityState {
  sessionId: string;
  turnId: string;
  runId: string;
  primary: Readonly<Route>;
  fallback: Readonly<Route>;
  allowLocalToCloud: boolean;
  revalidateBeforeFallback: (request: ChatCompletionRequest) => Promise<void>;
  dispatchGuard: LlmDispatchGuard;
  claimed: boolean;
}

type BoundRequest = ChatCompletionRequest & {
  [AUTHORIZATION]?: ChatProviderFallbackAuthorization;
  [REQUIRED]?: true;
};

/** Only the canonical admission owner may issue this process-local handle after
 * validating the durable route receipt. JSON cannot manufacture or retain it. */
export function issueChatProviderFallbackAuthorization(
  input: Omit<AuthorityState, "claimed">,
): ChatProviderFallbackAuthorization {
  for (const value of [
    input.sessionId,
    input.turnId,
    input.runId,
    input.primary.providerId,
    input.primary.model,
    input.fallback.providerId,
    input.fallback.model,
  ]) {
    if (typeof value !== "string" || !value.trim() || value.length > 512)
      reject("Invalid fallback authority identity.");
  }
  if (
    input.primary.providerId === input.fallback.providerId ||
    typeof input.allowLocalToCloud !== "boolean" ||
    typeof input.revalidateBeforeFallback !== "function" ||
    typeof input.dispatchGuard !== "function"
  ) {
    reject("Fallback requires one different provider and both live authority guards.");
  }
  const handle = Object.freeze({ kind: "server_chat_provider_fallback" as const });
  issued.set(handle, {
    ...input,
    primary: Object.freeze({ ...input.primary }),
    fallback: Object.freeze({ ...input.fallback }),
    claimed: false,
  });
  return handle;
}

/** Enumerable symbols survive internal request spreads but never JSON/wire output. */
export function markChatProviderFallbackRequired<T extends ChatCompletionRequest>(request: T): T {
  return { ...request, [REQUIRED]: true };
}

export function attachChatProviderFallbackAuthorization<T extends ChatCompletionRequest>(
  request: T,
  authorization: ChatProviderFallbackAuthorization,
): T {
  if (!issued.has(authorization)) reject("Fallback authorization was not issued by this runtime.");
  const result = { ...request, [REQUIRED]: true, [AUTHORIZATION]: authorization };
  readState(result);
  return result;
}

export function requiresChatProviderFallbackAuthorization(request: Partial<ChatCompletionRequest>): boolean {
  return (request as BoundRequest)[REQUIRED] === true || Boolean(request.memory?.turnId || request.memory?.runId);
}

export function readAuthorizedChatProviderFallback(request: ChatCompletionRequest): Readonly<Route> | undefined {
  return readState(request)?.fallback;
}

export function assertChatProviderFallbackPrimaryRoute(request: ChatCompletionRequest, route: Route): void {
  const state = readState(request);
  if (state && (state.primary.providerId !== route.providerId || state.primary.model !== route.model)) {
    reject("The primary provider route changed after fallback admission.");
  }
}

/** Claims exactly one fallback attempt, rechecks live authority, then returns a
 * guard that must execute again at the actual network-dispatch boundary. */
export function prepareCurrentChatProviderFallbackDispatch(
  host: { llmService: Pick<LlmService, "getRuntimeConfig"> },
  original: ChatCompletionRequest,
  effective: ChatCompletionRequest,
): Promise<LlmDispatchGuard | undefined> {
  return prepareChatProviderFallbackDispatch(
    original,
    effective,
    host.llmService.getRuntimeConfig({ useCache: false }).providers,
  );
}

export async function prepareChatProviderFallbackDispatch(
  original: ChatCompletionRequest,
  effective: ChatCompletionRequest,
  providers: ReadonlyArray<{ providerId: string; baseUrl?: string; hasApiKey?: boolean }>,
): Promise<LlmDispatchGuard | undefined> {
  const state = readState(original);
  if (!state) return undefined;
  if (state.claimed) reject("The admitted fallback attempt has already been consumed.");
  state.claimed = true;
  if (original.requiredRuntimeTarget) reject("A pinned runtime target cannot use cross-provider fallback.");
  if (effective.providerId !== state.fallback.providerId || effective.model !== state.fallback.model) {
    reject("The fallback target does not match its admitted route.");
  }
  const primary = providers.find((provider) => provider.providerId === state.primary.providerId);
  const fallback = providers.find((provider) => provider.providerId === state.fallback.providerId);
  if (!primary || !fallback || !primary.baseUrl || !fallback.baseUrl)
    reject("The fallback provider route is unavailable.");
  if (
    isLocalChatProviderUrl(primary.baseUrl) &&
    !isLocalChatProviderUrl(fallback.baseUrl) &&
    !state.allowLocalToCloud
  ) {
    reject("Local-to-cloud fallback requires explicit operator consent.");
  }
  try {
    await state.revalidateBeforeFallback(effective);
  } catch (error) {
    throw error instanceof LlmDispatchGuardRejectedError ? error : new LlmDispatchGuardRejectedError(error);
  }
  let dispatched = false;
  return async (input) => {
    if (dispatched) reject("The admitted fallback network attempt has already been consumed.");
    dispatched = true;
    if (input.route.providerId !== state.fallback.providerId || input.route.modelId !== state.fallback.model) {
      reject("The fallback route changed before network dispatch.");
    }
    await state.dispatchGuard(input);
  };
}

/** Shared boundary classification for preview and live fallback dispatch. */
export function isLocalChatProviderUrl(baseUrl: string | undefined): boolean {
  try {
    const url = new URL(baseUrl ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (
      host === "localhost" ||
      host === "host.docker.internal" ||
      host === "gateway.docker.internal" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".lan") ||
      host.endsWith(".internal") ||
      host.endsWith(".home.arpa") ||
      host.endsWith(".ts.net") ||
      (!host.includes(".") && !host.includes(":"))
    )
      return true;
    // URL canonicalizes IPv4 literals and IPv4-mapped IPv6 to these forms.
    // This is a privacy classification only; network policy still authorizes dispatch.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16);
      const low = Number.parseInt(mapped[2]!, 16);
      return isLocalIpv4([high >>> 8, high & 255, low >>> 8, low & 255]);
    }
    if (host.includes(":"))
      return host === "::" || host === "::1" || /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host);
    return /^\d+\.\d+\.\d+\.\d+$/.test(host) && isLocalIpv4(host.split(".").map(Number));
  } catch {
    return false;
  }
}

function isLocalIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 168) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 100 && b! >= 64 && b! <= 127)
  );
}

function readState(request: ChatCompletionRequest): AuthorityState | undefined {
  const handle = (request as BoundRequest)[AUTHORIZATION];
  if (handle === undefined) return undefined;
  const state = issued.get(handle);
  if (!state) reject("Fallback authorization was not issued by this runtime.");
  if (
    request.memory?.sessionId !== state.sessionId ||
    request.memory?.turnId !== state.turnId ||
    request.memory?.runId !== state.runId
  )
    reject("Fallback authorization belongs to a different Chat turn.");
  return state;
}

function reject(message: string): never {
  throw new LlmDispatchGuardRejectedError(new Error(message));
}
