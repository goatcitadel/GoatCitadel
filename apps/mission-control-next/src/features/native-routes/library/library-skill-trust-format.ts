export function describeSkillSourceDisposition(item: {
  installability?: string;
  skillFamily?: string;
  tags?: string[];
  name?: string;
}) {
  if (item.installability === "not_installable") {
    return "Rejected";
  }
  const family = item.skillFamily?.toLowerCase() ?? "";
  const conditionalFamilies = new Set([
    "openclaw_experiment",
    "github_connector_playbook",
    "google_cli_oauth",
    "copy_humanizer",
    "canvas_a2ui",
  ]);
  if (conditionalFamilies.has(family) || item.installability === "installable") {
    return "Conditional install";
  }
  const referenceOnlyFamilies = new Set([
    "auto_updates",
    "global_search_broker",
    "proactive_automation",
    "automation_designer",
    "decision_journal",
    "typed_memory_ontology",
    "frontend_review_guidance",
    "voice_transcription",
  ]);
  if (referenceOnlyFamilies.has(family)) {
    return "Reference only";
  }
  const nativeOverlapFamilies = new Set([
    "harness_engineering",
    "capability_evolution",
    "browser_automation",
    "cloudflare_dns",
    "skill_vetting",
    "multi_agent_swarm",
  ]);
  if (nativeOverlapFamilies.has(family)) {
    return "Native overlap";
  }
  if (item.installability === "review_only") {
    return "Reference only";
  }
  const haystack = [family, item.name, ...(item.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
  if (/native|overlap|vetting|capability|browser_automation|multi_agent_swarm/.test(haystack)) {
    return "Native overlap";
  }
  return "Reference only";
}

export function formatSkillImportPosture(details: unknown) {
  const record = readRecord(details);
  const disposition = readRecord(record.scriptDisposition);
  const scriptAction = typeof disposition.action === "string" ? disposition.action : "none";
  const mappings = Array.isArray(record.externalToolMappings) ? record.externalToolMappings : [];
  const mappedCount = mappings.filter((item) => readRecord(item).disposition === "mapped").length;
  const provenance = readRecord(record.provenance);
  const nonCallable = provenance.nonCallableUntilActivated === true ? "non-callable" : "provenance pending";
  const compatibility = readRecord(record.compatibility);
  const compatibilitySources = Array.isArray(compatibility.sources)
    ? compatibility.sources.filter((item): item is string => typeof item === "string")
    : [];
  const callability = typeof compatibility.callability === "string" ? compatibility.callability : "review_only";
  const compatibilityLabel = compatibilitySources.length ? compatibilitySources.join(", ") : "skill_md";
  return `${nonCallable}; scripts ${scriptAction}; tools ${mappedCount}/${mappings.length} mapped; compatibility ${callability} (${compatibilityLabel})`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
