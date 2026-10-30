// Google's sign-in redirect reaches GoatCitadel's loopback callback, which hands the result to
// Capabilities › Connectors › Advanced setup in the URL fragment. The tab that started Connect Google completes it.
import { createOAuthReturnChannel, type OAuthReturn } from "./oauth-return-channel";

export type GoogleOAuthReturn = OAuthReturn;

const channel = createOAuthReturnChannel({
  channelName: "goatcitadel-google-oauth-return",
  fragment: "google-oauth-return",
  cleanedHash: "integration-connections",
});

export function isGoogleOAuthReturnFragment(hash: string): boolean {
  return channel.isFragment(hash);
}

export function consumeGoogleOAuthReturnFragment(location: Location = window.location): GoogleOAuthReturn | undefined {
  return channel.consume(location);
}

export function subscribeGoogleOAuthReturn(listener: (result: GoogleOAuthReturn) => void): () => void {
  return channel.subscribe(listener);
}

export function __resetGoogleOAuthReturnForTests() {
  channel.reset();
}
