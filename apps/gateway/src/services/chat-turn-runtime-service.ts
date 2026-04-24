import type {
  ChatCancelTurnResponse,
  RoutingPreflightRequest,
  RoutingPreflightResult,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatStreamChunk,
} from "@goatcitadel/contracts";
import * as chatTurnEntryService from "./chat-turn-entry-service.js";
import type { ChatTurnRuntimeHost } from "./chat-turn-runtime-host-composition.js";

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
  routePreflight(sessionId: string, input: RoutingPreflightRequest): Promise<RoutingPreflightResult>;
}

export class ChatTurnRuntimeService implements ChatTurnRuntime {
  public constructor(private readonly host: ChatTurnRuntimeHost) {}

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

  public routePreflight(sessionId: string, input: RoutingPreflightRequest): Promise<RoutingPreflightResult> {
    return chatTurnEntryService.routePreflight(this.host, sessionId, input);
  }

  public resumeAgentChatTurnStream(
    sessionId: string,
    turnId: string,
    sinceEventId?: string,
  ): AsyncGenerator<ChatStreamChunk> {
    return chatTurnEntryService.resumeAgentChatTurnStream(this.host, sessionId, turnId, sinceEventId);
  }
}
