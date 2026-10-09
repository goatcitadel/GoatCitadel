import { createTransientInputOwner } from "./transient-input-owner";
export { sessionDraftSectionKey } from "./transient-input-owner";
const publicDrafts = createTransientInputOwner(true);
export const { hasSessionDraft, useSessionDraftVersion, discardSessionDraft, useSessionDraft } = publicDrafts;
export const __resetSessionDraftsForTests = publicDrafts.resetForTests;
