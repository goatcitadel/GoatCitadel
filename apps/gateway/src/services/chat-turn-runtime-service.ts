import type {
  ChatCancelTurnResponse,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatStreamChunk,
} from "@goatcitadel/contracts";
import * as chatTurnEntryService from "./chat-turn-entry-service.js";
import type { ChatTurnEntryHost, ChatTurnResumeHost } from "./chat-turn-entry-service.js";

export interface ChatTurnRuntime {
  agentSendChatMessage(sessionId: string, input: ChatSendMessageRequest): Promise<ChatSendMessageResponse>;
  agentSendChatMessageStream(sessionId: string, input: ChatSendMessageRequest): AsyncGenerator<ChatStreamChunk>;
  retryChatTurn(
    sessionId: string,
    turnId: string,
    overrides?: Partial<ChatSendMessageRequest>,
  ): Promise<ChatSendMessageResponse>;
  retryChatTurnStream(
    sessionId: string,
    turnId: string,
    overrides?: Partial<ChatSendMessageRequest>,
  ): AsyncGenerator<ChatStreamChunk>;
  editChatTurn(sessionId: string, turnId: string, input: ChatSendMessageRequest): Promise<ChatSendMessageResponse>;
  editChatTurnStream(sessionId: string, turnId: string, input: ChatSendMessageRequest): AsyncGenerator<ChatStreamChunk>;
  cancelChatTurn(sessionId: string, turnId: string, cancelledBy?: string): Promise<ChatCancelTurnResponse>;
  resumeAgentChatTurnStream(sessionId: string, turnId: string, sinceEventId?: string): AsyncGenerator<ChatStreamChunk>;
}

export class ChatTurnRuntimeService implements ChatTurnRuntime {
  public constructor(private readonly host: ChatTurnEntryHost & ChatTurnResumeHost) {}

  public agentSendChatMessage(sessionId: string, input: ChatSendMessageRequest): Promise<ChatSendMessageResponse> {
    return chatTurnEntryService.agentSendChatMessage(this.host, sessionId, input);
  }

  public agentSendChatMessageStream(sessionId: string, input: ChatSendMessageRequest): AsyncGenerator<ChatStreamChunk> {
    return chatTurnEntryService.agentSendChatMessageStream(this.host, sessionId, input);
  }

  public retryChatTurn(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest> = {},
  ): Promise<ChatSendMessageResponse> {
    return chatTurnEntryService.retryChatTurn(this.host, sessionId, turnId, overrides);
  }

  public retryChatTurnStream(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest> = {},
  ): AsyncGenerator<ChatStreamChunk> {
    return chatTurnEntryService.retryChatTurnStream(this.host, sessionId, turnId, overrides);
  }

  public editChatTurn(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
  ): Promise<ChatSendMessageResponse> {
    return chatTurnEntryService.editChatTurn(this.host, sessionId, turnId, input);
  }

  public editChatTurnStream(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
  ): AsyncGenerator<ChatStreamChunk> {
    return chatTurnEntryService.editChatTurnStream(this.host, sessionId, turnId, input);
  }

  public cancelChatTurn(sessionId: string, turnId: string, cancelledBy?: string): Promise<ChatCancelTurnResponse> {
    return chatTurnEntryService.cancelChatTurn(this.host, sessionId, turnId, cancelledBy);
  }

  public resumeAgentChatTurnStream(
    sessionId: string,
    turnId: string,
    sinceEventId?: string,
  ): AsyncGenerator<ChatStreamChunk> {
    return chatTurnEntryService.resumeAgentChatTurnStream(this.host, sessionId, turnId, sinceEventId);
  }
}
