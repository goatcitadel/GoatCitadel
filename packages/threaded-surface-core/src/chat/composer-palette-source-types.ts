import type {
  AgentProfileRecord,
  ChatProjectRecord,
  SkillListItem,
  ThreadKnowledgeAttachmentRecord,
} from "@goatcitadel/contracts";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import type { CommandCatalogItem } from "./useChatSessionData";
import type { CommandSuggestionItem } from "../chat-command-suggestions";
import type { fetchFilesList } from "@goatcitadel/mission-control-shared/api/client";

export interface BuildSourcesInput {
  commandCatalog: CommandCatalogItem[];
  inlineCommandSuggestions: CommandSuggestionItem[];
  providerOptions: ChatModelProviderOption[];
  agents: AgentProfileRecord[];
  installedSkills: SkillListItem[];
  projects: ChatProjectRecord[];
  knowledgeAttachments: ThreadKnowledgeAttachmentRecord[];
  externalSourcesAvailable: boolean;
  workspaceExplorerAvailable?: boolean;
  typedRunVariablesEnabled: boolean;
  documentEditingEnabled?: boolean;
  sessionId?: string;
  loadFiles?: typeof fetchFilesList;
}
