// The Gateway's MCP OAuth callback redirects here with the provider result in the URL fragment.
// The tab that receives it forwards the result to the tab holding the in-memory authorization
// request over a same-origin BroadcastChannel, then clears the fragment. Nothing is stored, and
// the operator still reviews the completion before the Gateway sends the code anywhere.

const CHANNEL = "goatcitadel-mcp-oauth-return";
const FRAGMENT = "mcp-oauth-return";

export interface McpOAuthReturn {
  state: string;
  code?: string;
  error?: string;
}

type Listener = (result: McpOAuthReturn) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | undefined;

function deliver(result: McpOAuthReturn) {
  for (const listener of listeners) listener(result);
}

function openChannel(): BroadcastChannel | undefined {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent) => {
    const parsed = parseReturn(event.data);
    if (parsed) deliver(parsed);
  };
  return channel;
}

function parseReturn(value: unknown): McpOAuthReturn | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { state, code, error } = value as Record<string, unknown>;
  if (typeof state !== "string" || !state || state.length > 128) return undefined;
  if (typeof code === "string" && code && code.length <= 4096 && error === undefined) return { state, code };
  if (typeof error === "string" && error && error.length <= 128 && code === undefined) return { state, error };
  return undefined;
}

/** Reads a provider return from this tab's fragment, removes it from the address bar, and forwards it. */
export function consumeMcpOAuthReturnFragment(location: Location = window.location): McpOAuthReturn | undefined {
  const hash = location.hash.replace(/^#/u, "");
  if (!hash.startsWith(`${FRAGMENT}&`)) return undefined;
  const params = new URLSearchParams(hash.slice(FRAGMENT.length + 1));
  const result = parseReturn({
    state: params.get("state") ?? undefined,
    code: params.get("code") ?? undefined,
    error: params.get("error") ?? undefined,
  });
  window.history.replaceState(window.history.state, "", `${location.pathname}${location.search}#mcp-servers`);
  if (!result) return undefined;
  openChannel()?.postMessage(result);
  deliver(result);
  return result;
}

export function subscribeMcpOAuthReturn(listener: Listener): () => void {
  openChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetMcpOAuthReturnForTests() {
  listeners.clear();
  channel?.close();
  channel = undefined;
}
