/** Documented Fast mode model families. Account and region access still depend on OpenAI. */
export function supportsOpenAiFastMode(providerId: string | undefined, model: string | undefined): boolean {
  if (providerId !== "openai" && providerId !== "openai-codex") return false;
  const bareModel = model?.startsWith(`${providerId}/`) ? model.slice(providerId.length + 1) : model ?? "";
  return /^gpt-(?:6-(?:astra|sol|luna)|5\.6(?:-(?:sol|terra|luna))?|5\.5|5\.4(?:-(?:mini|nano))?)$/u.test(bareModel);
}
