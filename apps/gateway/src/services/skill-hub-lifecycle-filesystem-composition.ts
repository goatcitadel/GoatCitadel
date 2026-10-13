import { SkillHubLifecycleFilesystem } from "./skill-hub-lifecycle-filesystem.js";
import type { SkillHubLifecycleServiceOptions } from "./skill-hub-lifecycle-service.js";
export function createSkillHubLifecycleFilesystem(
  rootDir: string,
  options: Pick<SkillHubLifecycleServiceOptions, "filesystem" | "beforeFilesystemMutation">,
) {
  return new SkillHubLifecycleFilesystem(rootDir, {
    filesystem: options.filesystem,
    beforeMutation: options.beforeFilesystemMutation,
  });
}
