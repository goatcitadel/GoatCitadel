import {
  SECRET_REDACTION_MARKER,
  isChannelAddressHost,
  type ChannelSetupDraft,
  type ChannelSetupDraftUpdateInput,
  type ChannelSetupFinalizeResult,
  type ChannelSetupTestResult,
  type ChannelSetupValidationResult,
} from "@goatcitadel/contracts";
import { preserveProjectedStructuredSecretsForPublicUpdate } from "./integration-connection-public-projection.js";
import { projectPublicSecretValue } from "./public-secret-projection.js";

export function projectChannelSetupDraftForPublicResponse(draft: ChannelSetupDraft): ChannelSetupDraft {
  const projected = projectPublicSecretValue(draft);
  const publicDraft = { ...projected.draft };
  const publicSecretState = Object.fromEntries(
    Object.entries(draft.secretState ?? {}).map(([fieldKey, state]) => {
      if (state.configured) publicDraft[fieldKey] = SECRET_REDACTION_MARKER;
      return [
        fieldKey,
        {
          configured: state.configured,
          custody: state.custody,
          ...(state.source ? { source: state.source } : {}),
          ...(isChannelAddressHost(state.host) ? { host: state.host } : {}),
        },
      ];
    }),
  );
  return {
    ...projected,
    draft: publicDraft,
    secretState: publicSecretState,
    ...(projected.hydration ? { hydration: projectHydrationHosts(projected.hydration, draft.hydration) } : {}),
  };
}

/**
 * The structured redactor hides every value keyed by a secret field's name, so it hides the recorded hosts too. A
 * recorded host is not secret: the hosts that are hosts are put back.
 */
function projectHydrationHosts(
  projected: NonNullable<ChannelSetupDraft["hydration"]>,
  source: ChannelSetupDraft["hydration"],
): NonNullable<ChannelSetupDraft["hydration"]> {
  const { addressHosts: _redacted, ...rest } = projected;
  const hosts = Object.entries(source?.addressHosts ?? {}).filter(([, host]) => isChannelAddressHost(host));
  return hosts.length ? { ...rest, addressHosts: Object.fromEntries(hosts) } : rest;
}

export function projectChannelSetupDraftsForPublicResponse(drafts: ChannelSetupDraft[]): ChannelSetupDraft[] {
  return drafts.map(projectChannelSetupDraftForPublicResponse);
}

export function projectChannelSetupFinalizeResultForPublicResponse(
  result: ChannelSetupFinalizeResult,
): ChannelSetupFinalizeResult {
  return projectPublicSecretValue(result);
}

export function projectChannelSetupValidationResultForPublicResponse(
  result: ChannelSetupValidationResult,
): ChannelSetupValidationResult {
  return projectPublicSecretValue(result);
}

export function projectChannelSetupTestResultForPublicResponse(result: ChannelSetupTestResult): ChannelSetupTestResult {
  return projectPublicSecretValue(result);
}

export function preserveChannelSetupDraftSecretsForPublicUpdate(
  current: ChannelSetupDraft,
  input: ChannelSetupDraftUpdateInput,
): ChannelSetupDraftUpdateInput {
  if (input.draft === undefined) {
    return { ...input };
  }

  return {
    ...input,
    draft: preserveProjectedStructuredSecretsForPublicUpdate(current.draft, input.draft),
  };
}
