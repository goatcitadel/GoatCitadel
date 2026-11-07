import {
  fetchChatCommandCatalog,
  fetchChatGeneratedArtifacts,
  fetchChatLearnedMemory,
  fetchChatProactiveRuns,
  fetchChatProactiveStatus,
  fetchChatSpecialistCandidates,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSkills,
  fetchThreadKnowledgeAttachments,
} from "@goatcitadel/mission-control-shared/api/client";

export async function readRuntimeCatalogEvidence() {
  const [commands, skills, servers, templates] = await Promise.all([
    fetchChatCommandCatalog(),
    fetchSkills(),
    fetchMcpServers(),
    fetchMcpTemplates(),
  ]);
  return { commands, skills, servers, templates };
}

export async function readSessionEvidence(sessionId: string) {
  const [proactive, runs, memory, specialists, artifacts, attachments] = await Promise.all([
    fetchChatProactiveStatus(sessionId),
    fetchChatProactiveRuns(sessionId, 30),
    fetchChatLearnedMemory(sessionId, 80),
    fetchChatSpecialistCandidates(sessionId, 80),
    fetchChatGeneratedArtifacts({ sessionId, limit: 200 }),
    fetchThreadKnowledgeAttachments(sessionId),
  ]);
  return { proactive, runs, memory, specialists, artifacts, attachments };
}
