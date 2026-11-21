import { ServiceUnavailableError, type AssistantSetupReviewInput } from "@goatcitadel/contracts";
import type { AssistantReadinessService } from "./assistant-readiness-service.js";
import type { ChatContinuationService } from "./chat-continuation-service.js";
import type { ChatLearningReceiptService } from "./chat-learning-receipt-service.js";
import type { FollowThroughProjectionService } from "./follow-through-projection-service.js";
import type { FollowThroughSetupService } from "./follow-through-setup-service.js";

interface ChatAssistantSupportRouteDependencies {
  assistantReadiness?: Pick<AssistantReadinessService, "getAssistantReadiness"> &
    Partial<Pick<AssistantReadinessService, "prepareSetup">>;
  followThrough?: Pick<FollowThroughProjectionService, "listFollowThrough" | "requestFollowThroughAction">;
  learningReceipt?: Pick<ChatLearningReceiptService, "getTurnLearningReceipt">;
  continuations?: Pick<ChatContinuationService, "inspect" | "prepare">;
  followThroughSetup?: Pick<FollowThroughSetupService, "inspect" | "create">;
}

/** Route adapter for the new readiness, learning and proactive Chat surfaces. */
export class ChatAssistantSupportRouteService {
  public constructor(private readonly deps: ChatAssistantSupportRouteDependencies) {}

  public getAssistantReadiness(sessionId: string, workspaceId?: string) {
    return requireOwner(this.deps.assistantReadiness, "Assistant readiness").getAssistantReadiness(
      sessionId,
      workspaceId,
    );
  }

  public prepareAssistantSetup(input: AssistantSetupReviewInput, actorId?: string) {
    const readiness = this.deps.assistantReadiness;
    if (!readiness?.prepareSetup)
      throw new ServiceUnavailableError("Assistant setup reviews are unavailable on this runtime.");
    return readiness.prepareSetup(input, actorId);
  }

  public getTurnLearningReceipt(sessionId: string, turnId: string, workspaceId?: string) {
    return requireOwner(this.deps.learningReceipt, "Learning receipts", "are").getTurnLearningReceipt(
      sessionId,
      turnId,
      workspaceId,
    );
  }

  public listFollowThrough(sessionId: string, workspaceId?: string) {
    return requireOwner(this.deps.followThrough, "Follow-through").listFollowThrough(sessionId, workspaceId);
  }

  public requestFollowThroughAction(
    input: Parameters<FollowThroughProjectionService["requestFollowThroughAction"]>[0],
    actorId?: string,
  ) {
    return requireOwner(this.deps.followThrough, "Follow-through").requestFollowThroughAction(input, actorId);
  }

  public inspectFollowThroughSetup(input: Parameters<FollowThroughSetupService["inspect"]>[0]) {
    return requireOwner(this.deps.followThroughSetup, "Schedule setup").inspect(input);
  }

  public createFollowThroughSetup(input: Parameters<FollowThroughSetupService["create"]>[0]) {
    return requireOwner(this.deps.followThroughSetup, "Schedule setup").create(input);
  }

  public inspectChatContinuation(input: Parameters<ChatContinuationService["inspect"]>[0]) {
    return requireOwner(this.deps.continuations, "Chat recovery").inspect(input);
  }

  public prepareChatContinuation(input: Parameters<ChatContinuationService["prepare"]>[0]) {
    return requireOwner(this.deps.continuations, "Chat recovery").prepare(input);
  }
}

function requireOwner<T>(owner: T | undefined, label: string, verb: "is" | "are" = "is"): T {
  if (!owner) throw new ServiceUnavailableError(`${label} ${verb} unavailable on this runtime.`);
  return owner;
}
