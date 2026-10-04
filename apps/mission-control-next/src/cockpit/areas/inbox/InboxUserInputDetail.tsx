import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChatUserInputPromptAnswerRequest,
  ChatUserInputPromptRecord,
  OperatorInboxItem,
} from "@goatcitadel/contracts";
import { answerChatUserInputPrompt, fetchChatThread } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { currentInboxUserInput, hasCurrentInboxUserInputItem } from "./inbox-user-input-guard";

type Answer = ChatUserInputPromptAnswerRequest["response"];

async function readCurrentQuestion(
  item: OperatorInboxItem,
  workspaceId: string,
): Promise<ChatUserInputPromptRecord | null> {
  if (!item.source.sessionId || !item.source.turnId || !item.source.promptId) return null;
  const projection = await fetchOperatorInbox(workspaceId);
  if (!hasCurrentInboxUserInputItem(item, projection, workspaceId)) return null;
  const thread = await fetchChatThread(item.source.sessionId);
  return currentInboxUserInput(item, projection, thread, workspaceId) ?? null;
}

export function InboxUserInputDetail({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const queryClient = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const scopeRef = useRef(activeWorkspaceId ?? "default");
  scopeRef.current = activeWorkspaceId ?? "default";
  const locked = useRef(false);
  const [selectedOptionId, setSelectedOptionId] = useState("");
  const [textValue, setTextValue] = useState("");
  const [review, setReview] = useState<{ prompt: ChatUserInputPromptRecord; response: Answer } | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["chat", "inbox-user-input", workspaceId, item.id, item.source.sessionId],
    queryFn: () => readCurrentQuestion(item, workspaceId),
    enabled: Boolean(item.source.sessionId && item.source.turnId && item.source.promptId),
    staleTime: 0,
  });
  const scopeChanged = scopeRef.current !== workspaceId;
  const prompt = query.isError ? undefined : query.data;
  const canAnswer = Boolean(prompt && !prompt.secureConfiguration && !scopeChanged && !completed && !outcomeUncertain);
  const selectedOption = prompt?.options?.find((option) => option.optionId === selectedOptionId);
  const hasAnswer = prompt?.kind === "single_select" ? Boolean(selectedOption) : Boolean(textValue.trim());
  const answerPreview = (() => {
    if (!review) return "";
    if (review.response.kind === "text") return review.response.text;
    const optionId = review.response.optionId;
    return review.prompt.options?.find((option) => option.optionId === optionId)?.label ?? "";
  })();

  function prepareAnswer() {
    if (!prompt || !canAnswer || !hasAnswer || pending) return;
    const response: Answer =
      prompt.kind === "single_select"
        ? { kind: "single_select", optionId: selectedOptionId }
        : { kind: "text", text: textValue.trim() };
    setReview({ prompt, response });
  }

  async function submitAnswer() {
    if (
      !review ||
      !item.source.sessionId ||
      !item.source.turnId ||
      !item.source.promptId ||
      locked.current ||
      pending ||
      completed ||
      outcomeUncertain ||
      scopeRef.current !== workspaceId
    )
      return;
    locked.current = true;
    setPending(true);
    setError("");
    let mutationAttempted = false;
    try {
      const latest = await readCurrentQuestion(item, workspaceId);
      if (
        scopeRef.current !== workspaceId ||
        !latest ||
        latest.secureConfiguration ||
        JSON.stringify(latest) !== JSON.stringify(review.prompt)
      ) {
        setReview(null);
        setError("The question changed or is no longer waiting. Refresh its current record before answering.");
        void query.refetch();
        return;
      }
      mutationAttempted = true;
      const result = await answerChatUserInputPrompt(item.source.sessionId, item.source.turnId, item.source.promptId, {
        response: review.response,
      });
      if (
        result.ok !== true ||
        result.sessionId !== item.source.sessionId ||
        result.turnId !== item.source.turnId ||
        result.promptId !== item.source.promptId
      ) {
        throw new Error("Gateway returned an unexpected answer receipt.");
      }
      setReview(null);
      setCompleted(true);
      setNotice(
        result.resumed
          ? "Gateway accepted the answer and reports that the turn resumed. Open Chat to inspect its progress."
          : "Gateway accepted the answer. Open Chat to inspect the current wait and continuation.",
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    } catch (cause) {
      setReview(null);
      if (mutationAttempted) {
        setOutcomeUncertain(true);
        setError(
          `Answer outcome is uncertain. Inspect the current question in Chat before trying again. ${describeApiError(cause).summary}`,
        );
      } else {
        setError(`Could not check the current question. ${describeApiError(cause).summary}`);
      }
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-label="Current Chat question" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-semibold text-fg">Current Chat question</h3>
        <Button
          size="sm"
          disabled={query.isFetching || pending}
          onClick={() => {
            setReview(null);
            setError("");
            setSelectedOptionId("");
            setTextValue("");
            void query.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      {!item.source.sessionId || !item.source.turnId || !item.source.promptId ? (
        <p role="alert" className="text-status-failed">
          This Inbox item has no complete question owner. Open Chat to review it.
        </p>
      ) : null}
      {query.isLoading ? (
        <p role="status" className="text-fg-muted">
          Loading the current question…
        </p>
      ) : query.isFetching ? (
        <p role="status" className="text-fg-muted">
          Checking for changes…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-status-failed">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {!query.isFetching && !query.isError && !prompt ? (
        <p className="text-fg-muted">
          This question is no longer waiting in the selected workspace. Open Chat to inspect its current state.
        </p>
      ) : null}
      {scopeChanged ? (
        <p role="alert" className="text-fg-secondary">
          The selected workspace changed. Open this item again in the current Inbox.
        </p>
      ) : null}
      {prompt ? (
        <>
          <p className="font-medium text-fg">{prompt.title}</p>
          <p className="text-fg-secondary">{prompt.question}</p>
          {prompt.secureConfiguration ? (
            <p className="text-fg-secondary">
              This question needs protected configuration. Open Chat to enter it through the existing secure flow.
            </p>
          ) : null}
          {canAnswer && prompt.kind === "single_select" ? (
            <fieldset className="space-y-2">
              <legend className="sr-only">Choose an answer</legend>
              {(prompt.options ?? []).map((option) => (
                <label
                  key={option.optionId}
                  className="flex cursor-pointer gap-2 rounded-md border border-line bg-sunken p-2 text-fg-secondary has-[:checked]:border-accent"
                >
                  <input
                    type="radio"
                    name={`inbox-answer-${prompt.promptId}`}
                    value={option.optionId}
                    checked={selectedOptionId === option.optionId}
                    disabled={pending}
                    onChange={() => setSelectedOptionId(option.optionId)}
                  />
                  <span>
                    <span className="font-medium text-fg">{option.label}</span>
                    <span className="block text-xs">{option.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {canAnswer && prompt.kind === "text" ? (
            <label className="block space-y-1 text-fg-secondary">
              <span>Your answer</span>
              {prompt.multiline ? (
                <textarea
                  rows={4}
                  value={textValue}
                  placeholder={prompt.placeholder}
                  disabled={pending}
                  onChange={(event) => setTextValue(event.target.value)}
                  className="w-full rounded-md border border-line bg-sunken p-2 text-fg"
                />
              ) : (
                <input
                  type="text"
                  value={textValue}
                  placeholder={prompt.placeholder}
                  disabled={pending}
                  onChange={(event) => setTextValue(event.target.value)}
                  className="w-full rounded-md border border-line bg-sunken p-2 text-fg"
                />
              )}
            </label>
          ) : null}
          {canAnswer ? (
            <Button variant="primary" disabled={!hasAnswer || pending} onClick={prepareAnswer}>
              Review answer
            </Button>
          ) : null}
        </>
      ) : null}
      {pending ? (
        <p role="status" className="text-fg-muted">
          Checking the current question and submitting your answer…
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-status-done">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-status-failed">
          {error}
        </p>
      ) : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !pending) setReview(null);
        }}
        title="Submit this answer"
        description="The Gateway will record this answer for the current Chat turn and may resume its run."
      >
        <p className="mb-3 max-h-32 overflow-auto whitespace-pre-wrap break-words text-sm text-fg-secondary">
          {answerPreview}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={pending || scopeChanged} onClick={() => void submitAnswer()}>
            Confirm answer
          </Button>
          <Button disabled={pending} onClick={() => setReview(null)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
