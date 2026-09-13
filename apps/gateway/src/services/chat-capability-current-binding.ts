import {
  canonicalJsonString,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityProfileRecord,
} from "@goatcitadel/contracts";
import {
  verifyChatTurnCapabilityProfile,
  verifyChatTurnCapabilityCatalogBinding,
  verifyChatTurnCapabilitySkillBindings,
  verifyCapabilityCatalogEntryUniqueness,
  resolveCapabilityCatalogToolName,
  type AsyncStorage,
} from "@goatcitadel/storage";

/** Shared Chat/worker gate: frozen profiles cannot revive withdrawn capabilities. */
export async function assertChatCapabilityBindingsCurrent(
  profile: ChatTurnCapabilityProfileRecord,
  storage: Pick<AsyncStorage, "capabilityCatalogSnapshots" | "skillLifecycle">,
  liveCallableEntries: readonly CapabilityCatalogEntry[] | undefined,
  revalidateRequesterTool?: (profile: ChatTurnCapabilityProfileRecord, canonicalName: string) => Promise<void>,
  revalidateMeshTool?: (profile: ChatTurnCapabilityProfileRecord, canonicalName: string) => Promise<void>,
): Promise<void> {
  verifyChatTurnCapabilityProfile(profile);
  const persistedCatalog = await storage.capabilityCatalogSnapshots.get(profile.catalog.snapshotId);
  verifyChatTurnCapabilityCatalogBinding(profile, persistedCatalog);
  verifyChatTurnCapabilitySkillBindings(profile, await storage.skillLifecycle.list());
  if (profile.selection.tools.length === 0 && profile.selection.trustedSkills.length === 0) return;
  if (!liveCallableEntries)
    throw new Error(`Capability profile ${profile.profileId} cannot verify the current callable catalog.`);
  verifyCapabilityCatalogEntryUniqueness([...liveCallableEntries], "current callable capability catalog");
  const liveById = new Map(liveCallableEntries.map((entry) => [entry.capabilityId, entry]));
  const persistedTools = new Map(
    persistedCatalog.callableEntries.flatMap((entry) => {
      const name = resolveCapabilityCatalogToolName(entry);
      return name ? [[name, entry] as const] : [];
    }),
  );
  const persistedSkills = new Map(
    persistedCatalog.callableEntries
      .filter((entry) => entry.kind === "skill" && entry.skillId)
      .map((entry) => [entry.capabilityId, entry]),
  );
  const assertStillCallable = (entry: CapabilityCatalogEntry | undefined, label: string) => {
    const live = entry ? liveById.get(entry.capabilityId) : undefined;
    if (!entry || !live || !live.callable || canonicalJsonString(live) !== canonicalJsonString(entry))
      throw new Error(`Capability profile ${profile.profileId} ${label} is no longer in the current callable catalog.`);
  };
  for (const tool of profile.selection.tools) {
    const entry = persistedTools.get(tool.canonicalName);
    if (entry?.sourceRef?.startsWith("mcp-tool-definition:") && (tool.mcpRequesterResolution || tool.mcpStaticBinding)) {
      // Native MCP catalogs are private to this profile, never shared global
      // catalog state. The MCP owner must recheck its live authority; a worker
      // or caller without that owner cannot adopt a private catalog by itself.
      assertStillCallable(persistedTools.get("mcp.invoke"), "shared MCP capability");
      if (!revalidateRequesterTool || liveById.has(entry.capabilityId))
        throw new Error(`Capability profile ${profile.profileId} cannot verify its native MCP catalog.`);
      await revalidateRequesterTool(profile, tool.canonicalName);
    } else {
      assertStillCallable(entry, `tool ${tool.canonicalName}`);
      if (tool.meshPublication) {
        if (!revalidateMeshTool)
          throw new Error(`Capability profile ${profile.profileId} cannot verify its current mesh authority.`);
        await revalidateMeshTool(profile, tool.canonicalName);
      }
    }
  }
  for (const skill of profile.selection.trustedSkills) {
    const entry = persistedSkills.get(skill.capabilityId);
    if (entry?.skillId !== skill.skillId)
      throw new Error(
        `Capability profile ${profile.profileId} skill ${skill.skillId} has a malformed catalog binding.`,
      );
    assertStillCallable(entry, `skill ${skill.skillId}`);
  }
}
