import {
  GOOGLE_WORKSPACE_CATALOG_ID,
  HEARTBEAT_PERMISSION_PROFILE_ID,
  NotFoundError,
  ValidationError,
  clampInt,
  getGoogleWorkspaceCapability,
  googleWorkspaceCapabilitiesForTool,
  isGoogleWorkspaceReadTool,
  readEnabledGoogleWorkspaceCapabilities,
  type GoogleWorkspaceCapability,
  type IntegrationConnection,
  type ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { z } from "zod";

export const GOOGLE_CONNECTION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const GOOGLE_READ_TIME = z.iso.datetime({ offset: true });
const CALENDAR_READ_FIELDS = new Set([
  "connectionId",
  "calendarId",
  "fromIso",
  "toIso",
  "timeMin",
  "timeMax",
  "maxResults",
  "pageToken",
]);
const GMAIL_READ_FIELDS = new Set(["connectionId", "query", "maxResults", "pageToken"]);

interface GoogleRequestDeps {
  connections: Pick<AsyncStorage["integrationConnections"], "list">;
  readConnection(connectionId: string): Promise<IntegrationConnection>;
  readEligibleSignInId(
    connection: IntegrationConnection,
    capabilities: readonly GoogleWorkspaceCapability[],
  ): string | undefined;
}

/** Bind the exact native request before policy can save it as a pending approval. */
export async function normalizeGoogleToolRequest(
  deps: GoogleRequestDeps,
  request: ToolInvokeRequest,
): Promise<ToolInvokeRequest> {
  const read = isGoogleWorkspaceReadTool(request.toolName);
  const args = read ? normalizeReadArgs(request) : request.args;
  const requiredCapabilities = googleWorkspaceCapabilitiesForTool(request.toolName, args);
  const selectionMessage = read
    ? "Choose a saved Google connection for this read."
    : "Choose a saved Google connection.";
  const connectionId = args.connectionId;
  let connections: IntegrationConnection[];
  if (typeof connectionId === "string" && GOOGLE_CONNECTION_ID_PATTERN.test(connectionId.trim())) {
    const connection = await deps.readConnection(connectionId.trim()).catch((error: unknown) => {
      if (error instanceof NotFoundError) {
        throw new ValidationError({
          message: "That Google connection could not be found. Choose a saved connection.",
        });
      }
      throw error;
    });
    connections = [connection];
  } else if (
    connectionId === undefined &&
    request.turnId &&
    request.policyContext?.permissionProfileId !== HEARTBEAT_PERMISSION_PROFILE_ID
  ) {
    const limit = 201;
    connections = await deps.connections.list("automation", limit);
    if (connections.length >= limit) throw new ValidationError({ message: selectionMessage });
  } else {
    throw new ValidationError({ message: selectionMessage });
  }
  const eligible = connections.flatMap((connection) => {
    const enabled = readEnabledGoogleWorkspaceCapabilities(connection.config);
    if (
      connection.catalogId !== GOOGLE_WORKSPACE_CATALOG_ID ||
      !connection.enabled ||
      connection.status !== "connected" ||
      (connection.workspaceId !== undefined && connection.workspaceId !== request.workspaceId) ||
      !requiredCapabilities.every((capability) => enabled.includes(capability))
    )
      return [];
    const signInId = deps.readEligibleSignInId(connection, requiredCapabilities);
    return signInId ? [{ connectionId: connection.connectionId, signInId }] : [];
  });
  if (eligible.length !== 1) {
    const operation = read ? "read" : "action";
    const labels = read
      ? request.toolName === "gmail.read"
        ? "Gmail read"
        : "Calendar read"
      : requiredCapabilities.map((capability) => getGoogleWorkspaceCapability(capability).label).join(" and ");
    throw new ValidationError({
      message: eligible.length
        ? `More than one Google account can perform this ${operation}. Choose a saved connection.`
        : `Connect Google and enable ${labels} under Capabilities › Connectors.`,
    });
  }
  const account = eligible[0]!;
  return { ...request, args: { ...args, connectionId: account.connectionId }, googleReadSignInId: account.signInId };
}

function normalizeReadArgs(request: ToolInvokeRequest): ToolInvokeRequest["args"] {
  const gmail = request.toolName === "gmail.read";
  const args = { ...request.args };
  const fields = gmail ? GMAIL_READ_FIELDS : CALENDAR_READ_FIELDS;
  if (Object.keys(args).some((key) => !fields.has(key))) {
    throw new ValidationError({
      message: gmail
        ? "Gmail searches accept connectionId, query, maxResults and pageToken."
        : "Calendar reads accept connectionId, calendarId, fromIso, toIso, maxResults and pageToken.",
    });
  }
  if (
    args.pageToken !== undefined &&
    (typeof args.pageToken !== "string" || !args.pageToken || args.pageToken.length > 8192)
  ) {
    throw new ValidationError({ message: "The saved page token is invalid. Start the query again." });
  }
  const textField = gmail ? "query" : "calendarId";
  const textValue = args[textField];
  if (textValue !== undefined && typeof textValue !== "string") {
    throw new ValidationError({ message: `${textField} must be text.` });
  }
  if (typeof textValue === "string") {
    const trimmed = textValue.trim();
    if ((gmail ? trimmed.length : textValue.length) > 512) {
      throw new ValidationError({
        message: gmail ? "The Gmail query is too long (maximum 512 characters)." : "The Calendar ID is too long.",
      });
    }
    args[textField] = trimmed || undefined;
  }
  if (args.maxResults !== undefined) {
    if (typeof args.maxResults !== "number" || !Number.isFinite(args.maxResults)) {
      throw new ValidationError({ message: "maxResults must be a number." });
    }
    args.maxResults = clampInt(args.maxResults, 10, 1, gmail ? 25 : 100);
  }
  if (!gmail) {
    const fromIso = normalizeGoogleReadTime(args, "fromIso", "timeMin");
    const toIso = normalizeGoogleReadTime(args, "toIso", "timeMax");
    if (fromIso && toIso && Date.parse(fromIso) >= Date.parse(toIso)) {
      throw new ValidationError({ message: "The Calendar end time must be after its start time." });
    }
    delete args.timeMin;
    delete args.timeMax;
    if (fromIso) args.fromIso = fromIso;
    if (toIso) args.toIso = toIso;
  }
  return args;
}

function normalizeGoogleReadTime(
  args: Record<string, unknown>,
  field: "fromIso" | "toIso",
  alias: "timeMin" | "timeMax",
): string | undefined {
  const value = args[field] === undefined ? args[alias] : args[field];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !GOOGLE_READ_TIME.safeParse(value).success ||
    (args[alias] !== undefined && args[alias] !== value)
  ) {
    throw new ValidationError({ message: `Calendar ${field} must be a timestamp with a time zone.` });
  }
  return value;
}
