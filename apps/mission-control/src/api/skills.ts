/** Skills domain slice. Pure re-exports from client.ts. */
export {
  fetchSkills,
  reloadSkills,
  fetchSkillSources,
  fetchSkillLookup,
  validateSkillImport,
  installSkillImport,
  fetchSkillImportHistory,
  updateSkillState,
  bulkUpdateSkillState,
  fetchSkillActivationPolicies,
  patchSkillActivationPolicies,
} from "./client.js";
