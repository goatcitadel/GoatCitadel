import type {
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  McpServerRecord,
  McpServerTemplateRecord,
} from "@goatcitadel/contracts";
import {
  activateImportedAgentCatalogEntry,
  createChatSpecialistCandidate,
  fetchChatSpecialistCandidates,
  fetchMcpServers,
  fetchMcpTemplates,
  updateChatSpecialistCandidate,
} from "@goatcitadel/mission-control-shared/api/client";
import type { Dispatch, SetStateAction } from "react";
import { assertContextRecord } from "./context-mutation-evidence";
import type { useChatContextMutationOwner } from "./useChatContextMutationOwner";

type SpecialistActionOwner = ReturnType<typeof useChatContextMutationOwner>;
export type SpecialistAction =
  | { kind: "draft"; suggestion: ChatSpecialistCandidateSuggestionRecord; turnId: string | null }
  | { kind: "patch"; candidateId: string; patch: ChatSpecialistCandidatePatchInput; notice: string }
  | { kind: "activate"; entryId: string }
  | { kind: "inspect" };

export function runSpecialistAction(
  input: {
    run: SpecialistActionOwner["run"];
    inspect: SpecialistActionOwner["inspect"];
    sessionId: string;
    workspaceId: string;
    setSending: (sending: boolean) => void;
    setCandidates: Dispatch<SetStateAction<ChatSpecialistCandidateRecord[]>>;
    setSuggestions: Dispatch<SetStateAction<ChatSpecialistCandidateSuggestionRecord[]>>;
    pushLocalNotice: (message: string, tone: "success", current: () => boolean) => void;
  },
  action: SpecialistAction,
): Promise<void> {
  const { sessionId, workspaceId, setSending, setCandidates, setSuggestions, pushLocalNotice } = input;
  const busy = { begin: () => setSending(true), end: () => setSending(false) };
  const candidateId = (candidate: ChatSpecialistCandidateRecord, expectedId?: string) =>
    assertContextRecord(candidate, sessionId, workspaceId, "candidateId", expectedId);
  const addCandidate = (candidate: ChatSpecialistCandidateRecord, current: () => boolean) =>
    setCandidates((items) =>
      current() ? [candidate, ...items.filter((item) => item.candidateId !== candidate.candidateId)] : items,
    );
  switch (action.kind) {
    case "draft":
      return input.run(
        "specialist-draft",
        () => createChatSpecialistCandidate(sessionId, { turnId: action.turnId ?? undefined, suggestion: action.suggestion }),
        (created) => [candidateId(created)],
        (created, current) => {
          addCandidate(created, current);
          setSuggestions((items) =>
            current() ? items.filter((item) => JSON.stringify(item) !== JSON.stringify(action.suggestion)) : items,
          );
          pushLocalNotice(`Drafted specialist candidate: ${created.title}.`, "success", current);
        },
        busy,
      );
    case "patch":
      return input.run(
        "specialist-patch",
        () => updateChatSpecialistCandidate(sessionId, action.candidateId, action.patch),
        (updated) => [candidateId(updated, action.candidateId)],
        (updated, current) => {
          setCandidates((items) =>
            current() ? items.map((item) => (item.candidateId === updated.candidateId ? updated : item)) : items,
          );
          pushLocalNotice(action.notice, "success", current);
        },
        busy,
      );
    case "activate":
      return input.run(
        "specialist-activation",
        () => activateImportedAgentCatalogEntry(action.entryId, { sessionId }),
        (activated) => {
          const id = candidateId(activated.specialist);
          if (
            activated.catalogEntry.entryId !== action.entryId ||
            activated.specialist.routingMode !== "manual_only" ||
            activated.specialist.status !== "active"
          )
            throw new TypeError("The activation receipt does not confirm the reviewed manual-only specialist.");
          return [activated.catalogEntry.entryId, id];
        },
        (activated, current) => {
          addCandidate(activated.specialist, current);
          setSuggestions((items) => (current() ? items.filter((item) => item.candidateId !== action.entryId) : items));
          pushLocalNotice(
            `Activated ${activated.catalogEntry.definition.frontmatter.name} for this session as a manual-only specialist.`,
            "success",
            current,
          );
        },
        busy,
      );
    case "inspect":
      return input.inspect(
        () => fetchChatSpecialistCandidates(sessionId, 500),
        (result) => {
          if (!Array.isArray(result.items)) throw new TypeError("The Gateway returned no specialist candidates.");
          result.items.forEach((item) => candidateId(item));
        },
        (result, current) => setCandidates((items) => (current() ? result.items : items)),
      );
  }
}

export async function openMcpSuggestion(
  current: () => boolean,
  setServers: (servers: McpServerRecord[]) => void,
  setTemplates: (templates: Array<McpServerTemplateRecord & { installed: boolean }>) => void,
): Promise<boolean> {
  if (!current()) return false;
  const { items: servers } = await fetchMcpServers();
  if (!current()) return false;
  setServers(servers);
  const { items: templates } = await fetchMcpTemplates();
  if (!current()) return false;
  setTemplates(templates);
  window.location.hash = "mcp";
  return true;
}
