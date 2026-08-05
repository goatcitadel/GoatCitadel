import type {
  ChatProjectImportInput,
  ChatProjectImportResult,
  ChatProjectLifecycleStatus,
  ChatProjectRecord,
} from "@goatcitadel/contracts";
import { createRouteService } from "./route-service-factory.js";

export const chatProjectsRouteMethods = [
  "archiveChatProject",
  "createChatProject",
  "hardDeleteChatProject",
  "importChatProject",
  "listChatProjects",
  "restoreChatProject",
  "updateChatProject",
] as const;

export type ChatProjectsRouteMethod = (typeof chatProjectsRouteMethods)[number];

interface ChatProjectCreateInput {
  citadelId?: string;
  workspaceId?: string;
  name: string;
  description?: string;
  workspacePath: string;
  color?: string;
}

interface ChatProjectUpdateInput {
  citadelId?: string;
  workspaceId?: string;
  name?: string;
  description?: string;
  workspacePath?: string;
  color?: string;
}

export interface ChatProjectsRoutePort {
  archiveChatProject(projectId: string, expectedRevision: number): Promise<ChatProjectRecord>;
  createChatProject(input: ChatProjectCreateInput): Promise<ChatProjectRecord>;
  hardDeleteChatProject(projectId: string, expectedRevision: number): Promise<boolean>;
  importChatProject(input: ChatProjectImportInput): Promise<ChatProjectImportResult>;
  listChatProjects(
    view?: ChatProjectLifecycleStatus | "all",
    limit?: number,
    workspaceId?: string,
    citadelId?: string,
  ): Promise<ChatProjectRecord[]>;
  restoreChatProject(projectId: string, expectedRevision: number): Promise<ChatProjectRecord>;
  updateChatProject(
    projectId: string,
    input: ChatProjectUpdateInput,
    expectedRevision: number,
  ): Promise<ChatProjectRecord>;
}

export type ChatProjectsRouteService = Readonly<ChatProjectsRoutePort>;

export function createChatProjectsRouteService(port: ChatProjectsRoutePort): ChatProjectsRouteService {
  return createRouteService(port, chatProjectsRouteMethods) as ChatProjectsRouteService;
}
