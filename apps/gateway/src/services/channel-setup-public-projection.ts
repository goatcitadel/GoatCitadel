import {
  SECRET_REDACTION_MARKER,
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
      return [fieldKey, { configured: state.configured, custody: state.custody }];
    }),
  );
  return { ...projected, draft: publicDraft, secretState: publicSecretState };
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
