// The Gateway's MCP OAuth callback redirects to Capabilities › Connectors › Advanced setup with the provider result in
// the URL fragment.
// The tab that receives it forwards the result to the tab holding the in-memory authorization
// request over a same-origin BroadcastChannel, then clears the fragment. Nothing is stored, and
// the operator still reviews the completion before the Gateway sends the code anywhere.
import { createOAuthReturnChannel, type OAuthReturn } from "./oauth-return-channel";

export type McpOAuthReturn = OAuthReturn;

const channel = createOAuthReturnChannel({
  channelName: "goatcitadel-mcp-oauth-return",
  fragment: "mcp-oauth-return",
  cleanedHash: "mcp-servers",
});

/** True for the fragment the Gateway's OAuth callback lands on (without the leading `#`). */
export function isMcpOAuthReturnFragment(hash: string): boolean {
  return channel.isFragment(hash);
}

/** Reads a provider return from this tab's fragment, removes it from the address bar, and forwards it. */
export function consumeMcpOAuthReturnFragment(location: Location = window.location): McpOAuthReturn | undefined {
  return channel.consume(location);
}

export function subscribeMcpOAuthReturn(listener: (result: McpOAuthReturn) => void): () => void {
  return channel.subscribe(listener);
}

export function __resetMcpOAuthReturnForTests() {
  channel.reset();
}
