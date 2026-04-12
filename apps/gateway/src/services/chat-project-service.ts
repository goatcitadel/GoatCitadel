import type { ChatProjectRecord, RealtimeEvent } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export interface ChatProjectServiceContext {
  readonly storage: Pick<Storage, "chatProjects">;
  normalizeWorkspaceId(workspaceId?: string): string | undefined;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
}

/**
 * Encapsulates chat-project CRUD behind the narrow storage/workspace/realtime
 * dependencies it actually needs.
 */
export class ChatProjectService {
  constructor(private readonly ctx: ChatProjectServiceContext) {}

  listChatProjects(
    view: "active" | "archived" | "all" = "active",
    limit = 300,
    workspaceId?: string,
  ): ChatProjectRecord[] {
    return this.ctx.storage.chatProjects.list(view, limit, this.ctx.normalizeWorkspaceId(workspaceId));
  }

  createChatProject(input: {
    workspaceId?: string;
    name: string;
    description?: string;
    workspacePath: string;
    color?: string;
  }): ChatProjectRecord {
    const created = this.ctx.storage.chatProjects.create({
      ...input,
      workspaceId: this.ctx.normalizeWorkspaceId(input.workspaceId),
    });
    this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_created",
      projectId: created.projectId,
      name: created.name,
      workspaceId: created.workspaceId,
    });
    return created;
  }

  updateChatProject(
    projectId: string,
    input: {
      workspaceId?: string;
      name?: string;
      description?: string;
      workspacePath?: string;
      color?: string;
    },
  ): ChatProjectRecord {
    const updated = this.ctx.storage.chatProjects.update(projectId, {
      ...input,
      workspaceId: input.workspaceId ? this.ctx.normalizeWorkspaceId(input.workspaceId) : undefined,
    });
    this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_updated",
      projectId: updated.projectId,
      name: updated.name,
      workspaceId: updated.workspaceId,
    });
    return updated;
  }

  archiveChatProject(projectId: string): ChatProjectRecord {
    const archived = this.ctx.storage.chatProjects.archive(projectId);
    this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_archived",
      projectId: archived.projectId,
    });
    return archived;
  }

  restoreChatProject(projectId: string): ChatProjectRecord {
    const restored = this.ctx.storage.chatProjects.restore(projectId);
    this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_restored",
      projectId: restored.projectId,
    });
    return restored;
  }

  hardDeleteChatProject(projectId: string): boolean {
    const deleted = this.ctx.storage.chatProjects.hardDelete(projectId);
    if (deleted) {
      this.ctx.publishRealtime("system", "chat", {
        type: "chat_project_deleted",
        projectId,
      });
    }
    return deleted;
  }
}
