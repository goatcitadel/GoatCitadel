import {
  getGoogleWorkspaceCapability,
  readEnabledGoogleWorkspaceCapabilities,
  type ConnectorDiagnosticReport,
  type GoogleWorkspaceOAuthStatus,
} from "@goatcitadel/contracts";

type Checks = ConnectorDiagnosticReport["checks"];

/** Configuration checks for a Gmail and Google Calendar connection; they read only saved config. */
export function buildGoogleWorkspaceConfigChecks(config: Record<string, unknown>): Checks {
  const clientId = typeof config.clientId === "string" ? config.clientId.trim() : "";
  const enabled = readEnabledGoogleWorkspaceCapabilities(config);
  const legacyToken = ["accessToken", "accessTokenEnv"].some(
    (key) => typeof config[key] === "string" && String(config[key]).trim(),
  );
  return [
    {
      key: "oauth_client",
      status: clientId ? "pass" : "fail",
      message: clientId
        ? "OAuth client ID is saved."
        : "OAuth client ID is missing. Add the client ID of a Google Cloud Desktop app client.",
    },
    {
      key: "capabilities",
      status: enabled.length ? "pass" : "warn",
      message: enabled.length
        ? `Turned on: ${enabled.map((capability) => getGoogleWorkspaceCapability(capability).label).join(", ")}.`
        : "No Gmail or Calendar capability is turned on, so Connect Google has nothing to request.",
    },
    ...(legacyToken
      ? [
          {
            key: "legacy_access_token",
            status: "warn" as const,
            message:
              "A pasted access token is still saved on this connection. It is ignored; the tools use the Google sign-in only.",
          },
        ]
      : []),
  ];
}

/** Sign-in readiness from the OS keychain. Nothing is sent to Google. */
export function buildGoogleWorkspaceSignInChecks(status: GoogleWorkspaceOAuthStatus): Checks {
  const checks: Checks = [];
  if (!status.keychainAvailable) {
    checks.push({
      key: "keychain",
      status: "fail",
      message: "The OS keychain is unavailable, so a Google sign-in cannot be kept or read.",
    });
  }
  checks.push({
    key: "client_secret",
    status: status.clientSecretSource === "none" ? "fail" : "pass",
    message:
      status.clientSecretSource === "keychain"
        ? "Client secret is kept in the OS keychain."
        : status.clientSecretSource === "env"
          ? "Client secret is read from its environment variable."
          : "Client secret is missing. Enter it when you connect Google.",
  });
  checks.push({
    key: "sign_in",
    status: status.connected ? "pass" : "fail",
    message: status.connected
      ? `Signed in to Google${status.accountLabel ? ` as ${status.accountLabel}` : ""}.`
      : status.requiresReauth
        ? "Google sign-in needs to be renewed. Connect Google again."
        : "Not signed in to Google yet. Choose Connect Google.",
  });
  for (const capability of status.capabilities.filter((item) => item.enabled)) {
    const label = getGoogleWorkspaceCapability(capability.capability).label;
    checks.push({
      key: `scope:${capability.capability}`,
      status: status.connected && capability.granted ? "pass" : "fail",
      message:
        status.connected && capability.granted
          ? `${label}: granted by Google.`
          : `${label}: turned on, but Google has not granted ${capability.scope}. Connect Google again and allow it.`,
    });
  }
  return checks;
}
