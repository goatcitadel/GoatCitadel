// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleWorkspaceOAuthStatus, IntegrationConnection } from "@goatcitadel/contracts";
import { GoogleWorkspaceSignIn } from "./GoogleWorkspaceSignIn";
import { __resetGoogleOAuthReturnForTests, consumeGoogleOAuthReturnFragment } from "./google-oauth-return";

const api = vi.hoisted(() => ({
  fetchGoogleWorkspaceOAuthStatus: vi.fn(),
  startGoogleWorkspaceOAuth: vi.fn(),
  completeGoogleWorkspaceOAuth: vi.fn(),
  disconnectGoogleWorkspaceOAuth: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));

const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const STATE = "44444444-4444-4444-8444-444444444444";
const connection: IntegrationConnection = {
  connectionId: CONNECTION_ID,
  revision: "r1",
  catalogId: "automation.gmail",
  kind: "automation",
  key: "gmail",
  label: "Google",
  enabled: true,
  status: "disconnected",
  config: { clientId: "1234567890-abc.apps.googleusercontent.com", gmailRead: true },
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
};

function status(overrides: Partial<GoogleWorkspaceOAuthStatus> = {}): GoogleWorkspaceOAuthStatus {
  return {
    connectionId: CONNECTION_ID,
    keychainAvailable: true,
    clientIdConfigured: true,
    clientSecretSource: "none",
    redirectUri: "http://127.0.0.1:8787/api/v1/integrations/google/oauth/callback",
    connected: false,
    requiresReauth: false,
    grantedScopes: [],
    capabilities: [
      {
        capability: "gmail.read",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        write: false,
        enabled: true,
        granted: false,
      },
      {
        capability: "gmail.send",
        scope: "https://www.googleapis.com/auth/gmail.send",
        write: true,
        enabled: false,
        granted: false,
      },
      {
        capability: "calendar.read",
        scope: "https://www.googleapis.com/auth/calendar.events.readonly",
        write: false,
        enabled: false,
        granted: false,
      },
      {
        capability: "calendar.write",
        scope: "https://www.googleapis.com/auth/calendar.events",
        write: true,
        enabled: false,
        granted: false,
      },
    ],
    legacyAccessTokenConfigured: false,
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(onChanged = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <GoogleWorkspaceSignIn connection={connection} onChanged={onChanged} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  return onChanged;
}

async function settle() {
  for (let index = 0; index < 5; index += 1)
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  __resetGoogleOAuthReturnForTests();
  window.history.replaceState(null, "", "/");
  vi.resetAllMocks();
});

describe("Connect Google", () => {
  it("reviews the exact scopes before opening Google, then completes when Google sends the code back", async () => {
    api.fetchGoogleWorkspaceOAuthStatus.mockResolvedValue(status());
    api.startGoogleWorkspaceOAuth.mockResolvedValue({
      connectionId: CONNECTION_ID,
      state: STATE,
      authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${STATE}`,
      redirectUri: "http://127.0.0.1:8787/api/v1/integrations/google/oauth/callback",
      capabilities: ["gmail.read", "calendar.read"],
      scopes: [],
      expiresAt: "2026-10-25T00:10:00.000Z",
    });
    api.completeGoogleWorkspaceOAuth.mockResolvedValue(
      status({
        connected: true,
        accountLabel: "operator@example.com",
        clientSecretSource: "keychain",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        capabilities: status().capabilities.map((item) =>
          item.capability === "gmail.read" ? { ...item, granted: true } : item,
        ),
      }),
    );
    const onChanged = await render();
    expect(container!.textContent).toContain("Not signed in to Google.");
    expect(container!.textContent).toContain("Send Gmail · Off · Asks for approval every time");

    await click(button("Connect Google", container!));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Review Google access");
    for (const scope of [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ])
      expect(dialog.textContent).toContain(scope);
    expect(api.startGoogleWorkspaceOAuth).not.toHaveBeenCalled();
    // A client secret is required before anything is sent.
    expect(button("Continue to Google", dialog).disabled).toBe(true);
    const calendar = [...dialog.querySelectorAll("label")].find((item) =>
      item.textContent?.startsWith("Read Calendar events"),
    )!;
    await click(calendar.querySelector("input")!);
    await type(dialog.querySelector('input[type="password"]')!, "GOCSPX-desktop-secret");
    await click(button("Continue to Google", dialog));

    expect(api.startGoogleWorkspaceOAuth).toHaveBeenCalledWith(CONNECTION_ID, {
      capabilities: ["gmail.read", "calendar.read"],
      clientSecret: "GOCSPX-desktop-secret",
    });
    const link = [...container!.querySelectorAll("a")].find((item) => item.textContent === "Open Google sign-in")!;
    expect(link.getAttribute("href")).toBe(`https://accounts.google.com/o/oauth2/v2/auth?state=${STATE}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    // Another sign-in's return is ignored.
    window.history.replaceState(null, "", "/settings/connections#google-oauth-return&state=other&code=x");
    await act(async () => void consumeGoogleOAuthReturnFragment());
    expect(api.completeGoogleWorkspaceOAuth).not.toHaveBeenCalled();

    window.history.replaceState(null, "", `/settings/connections#google-oauth-return&state=${STATE}&code=4%2F0Adeu`);
    await act(async () => void consumeGoogleOAuthReturnFragment());
    await settle();
    expect(window.location.hash).toBe("#integration-connections");
    expect(api.completeGoogleWorkspaceOAuth).toHaveBeenCalledWith(CONNECTION_ID, { state: STATE, code: "4/0Adeu" });
    expect(container!.textContent).toContain(
      "Connected to Google as operator@example.com. Allowed: Read Gmail. Google did not grant Read Calendar events, so those stay off.",
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("reports a refused consent without completing anything", async () => {
    api.fetchGoogleWorkspaceOAuthStatus.mockResolvedValue(status({ clientSecretSource: "keychain" }));
    api.startGoogleWorkspaceOAuth.mockResolvedValue({
      connectionId: CONNECTION_ID,
      state: STATE,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      redirectUri: "http://127.0.0.1:8787/api/v1/integrations/google/oauth/callback",
      capabilities: ["gmail.read"],
      scopes: [],
      expiresAt: "2026-10-25T00:10:00.000Z",
    });
    await render();
    await click(button("Connect Google", container!));
    const dialog = document.querySelector('[role="dialog"]')!;
    // The saved secret is kept: the field is optional now.
    await click(button("Continue to Google", dialog));
    expect(api.startGoogleWorkspaceOAuth).toHaveBeenCalledWith(CONNECTION_ID, { capabilities: ["gmail.read"] });
    window.history.replaceState(
      null,
      "",
      `/settings/connections#google-oauth-return&state=${STATE}&error=access_denied`,
    );
    await act(async () => void consumeGoogleOAuthReturnFragment());
    await settle();
    expect(api.completeGoogleWorkspaceOAuth).not.toHaveBeenCalled();
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(
      "Google did not grant access (access_denied). Nothing changed.",
    );
  });

  it("disconnects only after confirmation and says when Google did not confirm the revocation", async () => {
    api.fetchGoogleWorkspaceOAuthStatus.mockResolvedValue(
      status({ connected: true, accountLabel: "operator@example.com", clientSecretSource: "keychain" }),
    );
    api.disconnectGoogleWorkspaceOAuth.mockResolvedValue({
      revoked: false,
      message: "GoatCitadel removed its stored sign-in, but Google did not confirm the revocation (HTTP 503).",
      status: status({ clientSecretSource: "keychain" }),
    });
    await render();
    expect(container!.textContent).toContain("Signed in as operator@example.com.");
    expect(button("Reconnect Google", container!)).toBeTruthy();

    await click(button("Disconnect Google", container!));
    expect(api.disconnectGoogleWorkspaceOAuth).not.toHaveBeenCalled();
    const modal = document.querySelector('[role="dialog"]')!;
    expect(modal.textContent).toContain("Disconnect Google?");
    await click(button("Disconnect Google", modal));
    expect(api.disconnectGoogleWorkspaceOAuth).toHaveBeenCalledWith(CONNECTION_ID);
    expect(container!.querySelector('[role="alert"]')?.textContent).toMatch(/did not confirm the revocation/);
  });

  it("keeps Connect unavailable until a client ID is saved, and flags a leftover pasted token", async () => {
    api.fetchGoogleWorkspaceOAuthStatus.mockResolvedValue(
      status({ clientIdConfigured: false, legacyAccessTokenConfigured: true }),
    );
    await render();
    expect(button("Connect Google", container!).disabled).toBe(true);
    expect(container!.textContent).toContain("Save the OAuth client ID");
    expect(container!.textContent).toContain("A pasted access token is still saved on this connection.");
  });
});
