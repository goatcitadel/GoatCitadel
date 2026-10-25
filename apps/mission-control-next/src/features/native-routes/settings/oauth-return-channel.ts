// A provider's OAuth callback redirects to Settings with the result in the URL fragment. The tab
// that receives it forwards the result to the tab holding the in-memory sign-in request over a
// same-origin BroadcastChannel, then clears the fragment. Nothing is stored.

export interface OAuthReturn {
  state: string;
  code?: string;
  error?: string;
}

export interface OAuthReturnChannel {
  /** True for this channel's fragment (without the leading `#`). */
  isFragment(hash: string): boolean;
  /** Reads a provider return from this tab's fragment, removes it from the address bar, and forwards it. */
  consume(location?: Location): OAuthReturn | undefined;
  subscribe(listener: (result: OAuthReturn) => void): () => void;
  reset(): void;
}

export function createOAuthReturnChannel(options: {
  channelName: string;
  fragment: string;
  /** The hash left in the address bar once the fragment is consumed. */
  cleanedHash: string;
}): OAuthReturnChannel {
  const listeners = new Set<(result: OAuthReturn) => void>();
  let channel: BroadcastChannel | undefined;
  const deliver = (result: OAuthReturn) => {
    for (const listener of listeners) listener(result);
  };
  const open = (): BroadcastChannel | undefined => {
    if (channel || typeof BroadcastChannel === "undefined") return channel;
    channel = new BroadcastChannel(options.channelName);
    channel.onmessage = (event: MessageEvent) => {
      const parsed = parseOAuthReturn(event.data);
      if (parsed) deliver(parsed);
    };
    return channel;
  };
  const isFragment = (hash: string) => hash.replace(/^#/u, "").startsWith(`${options.fragment}&`);
  return {
    isFragment,
    consume(location = window.location) {
      const hash = location.hash.replace(/^#/u, "");
      if (!isFragment(hash)) return undefined;
      const params = new URLSearchParams(hash.slice(options.fragment.length + 1));
      const result = parseOAuthReturn({
        state: params.get("state") ?? undefined,
        code: params.get("code") ?? undefined,
        error: params.get("error") ?? undefined,
      });
      window.history.replaceState(
        window.history.state,
        "",
        `${location.pathname}${location.search}#${options.cleanedHash}`,
      );
      if (!result) return undefined;
      open()?.postMessage(result);
      deliver(result);
      return result;
    },
    subscribe(listener) {
      open();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      listeners.clear();
      channel?.close();
      channel = undefined;
    },
  };
}

function parseOAuthReturn(value: unknown): OAuthReturn | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { state, code, error } = value as Record<string, unknown>;
  if (typeof state !== "string" || !state || state.length > 128) return undefined;
  if (typeof code === "string" && code && code.length <= 4096 && error === undefined) return { state, code };
  if (typeof error === "string" && error && error.length <= 128 && code === undefined) return { state, error };
  return undefined;
}
