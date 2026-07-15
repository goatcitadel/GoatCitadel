import type {
  ChatCancelTurnResponse,
  RoutingPreflightRequest,
  RoutingPreflightResult,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatStreamChunk,
} from "@goatcitadel/contracts";
import * as chatTurnEntryService from "./chat-turn-entry-service.js";
import type {
  AgentChatTurnRequestOptions,
  OperatorChatTurnRequestOptions,
  OperatorChatTurnStreamRequestOptions,
} from "./chat-turn-entry-service.js";
import type { ChatTurnRuntimeHost } from "./chat-turn-runtime-host-composition.js";

export type ChatTurnStreamRequestOptions = OperatorChatTurnStreamRequestOptions;

export interface ChatTurnRuntime {
  agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: AgentChatTurnRequestOptions,
  ): Promise<ChatSendMessageResponse>;
  agentSendChatMessageStream(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: ChatTurnStreamRequestOptions,
  ): AsyncGenerator<ChatStreamChunk>;
  retryChatTurn(
    sessionId: string,
    turnId: string,
    overrides?: Partial<ChatSendMessageRequest>,
    options?: OperatorChatTurnRequestOptions,
  ): Promise<ChatSendMessageResponse>;
  retryChatTurnStream(
    sessionId: string,
    turnId: string,
    overrides?: Partial<ChatSendMessageRequest>,
    options?: ChatTurnStreamRequestOptions,
  ): AsyncGenerator<ChatStreamChunk>;
  editChatTurn(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
    options?: OperatorChatTurnRequestOptions,
  ): Promise<ChatSendMessageResponse>;
  editChatTurnStream(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
    options?: ChatTurnStreamRequestOptions,
  ): AsyncGenerator<ChatStreamChunk>;
  cancelChatTurn(sessionId: string, turnId: string, cancelledBy?: string): Promise<ChatCancelTurnResponse>;
  resumeAgentChatTurnStream(
    sessionId: string,
    turnId: string,
    sinceEventId?: string,
    options?: { abortSignal?: AbortSignal },
  ): AsyncGenerator<ChatStreamChunk>;
  routePreflight(sessionId: string, input: RoutingPreflightRequest): Promise<RoutingPreflightResult>;
}

export class ChatTurnRuntimeService implements ChatTurnRuntime {
  public constructor(private readonly host: ChatTurnRuntimeHost) {}

  public agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: AgentChatTurnRequestOptions,
  ): Promise<ChatSendMessageResponse> {
    return chatTurnEntryService.agentSendChatMessage(this.host, sessionId, input, options);
  }

  public agentSendChatMessageStream(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: ChatTurnStreamRequestOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    return options
      ? chatTurnEntryService.agentSendChatMessageStream(this.host, sessionId, input, options)
      : chatTurnEntryService.agentSendChatMessageStream(this.host, sessionId, input);
  }

  public retryChatTurn(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest> = {},
    options?: OperatorChatTurnRequestOptions,
  ): Promise<ChatSendMessageResponse> {
    return options
      ? chatTurnEntryService.retryChatTurn(this.host, sessionId, turnId, overrides, options)
      : chatTurnEntryService.retryChatTurn(this.host, sessionId, turnId, overrides);
  }

  public retryChatTurnStream(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest> = {},
    options?: ChatTurnStreamRequestOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    return options
      ? chatTurnEntryService.retryChatTurnStream(this.host, sessionId, turnId, overrides, options)
      : chatTurnEntryService.retryChatTurnStream(this.host, sessionId, turnId, overrides);
  }

  public editChatTurn(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
    options?: OperatorChatTurnRequestOptions,
  ): Promise<ChatSendMessageResponse> {
    return options
      ? chatTurnEntryService.editChatTurn(this.host, sessionId, turnId, input, options)
      : chatTurnEntryService.editChatTurn(this.host, sessionId, turnId, input);
  }

  public editChatTurnStream(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
    options?: ChatTurnStreamRequestOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    return options
      ? chatTurnEntryService.editChatTurnStream(this.host, sessionId, turnId, input, options)
      : chatTurnEntryService.editChatTurnStream(this.host, sessionId, turnId, input);
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
    options?: { abortSignal?: AbortSignal },
  ): AsyncGenerator<ChatStreamChunk> {
    return options
      ? chatTurnEntryService.resumeAgentChatTurnStream(this.host, sessionId, turnId, sinceEventId, options)
      : chatTurnEntryService.resumeAgentChatTurnStream(this.host, sessionId, turnId, sinceEventId);
  }
}
