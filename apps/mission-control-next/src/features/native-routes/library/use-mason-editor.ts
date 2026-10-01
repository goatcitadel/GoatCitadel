import { useLayoutEffect, useRef } from "react";
import type { MasonAnswers } from "@goatcitadel/contracts";
import { useSessionDraft } from "./session-drafts";
import { useCitadelMason } from "./use-citadel-mason";
import { useDraftLeave } from "./DraftLeaveDialog";
import { masonAnswerPatch } from "./mason-session-binding";

export function useMasonEditor(citadelId: string) {
  const control = useCitadelMason(citadelId);
  const questionKey = `mason:${control.scope}:${control.sessionId ?? "new"}:question:${control.questionIndex}`;
  const messageDraft = useSessionDraft(questionKey, "", undefined, { label: "Mason answer" });
  const answersDraft = useSessionDraft(
    `mason:${control.scope}:${control.sessionId ?? "new"}:answers`,
    control.session?.answers ?? {},
    control.session ? JSON.stringify(control.session) : undefined,
    { label: "Structured Mason answers", available: Boolean(control.session) },
  );
  const identity = JSON.stringify([
    control.scope,
    control.sessionId,
    control.questionIndex,
    messageDraft.value,
    answersDraft.isDirty ? answersDraft.value : null,
  ]);
  const live = useRef({ identity, generation: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation++;
  }
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.generation++;
    };
  }, []);
  const currentAt = (generation: number) => live.current.mounted && live.current.generation === generation;
  const leave = useDraftLeave();
  function changeMessage(value: string) {
    live.current.generation++;
    control.invalidateReview();
    messageDraft.setValue(value);
  }
  function changeAnswer<K extends keyof MasonAnswers>(key: K, value: MasonAnswers[K]) {
    live.current.generation++;
    control.invalidateReview();
    answersDraft.setValue((current) => ({ ...current, [key]: value }));
  }
  async function sendMessage(): Promise<boolean> {
    const text = messageDraft.value,
      generation = live.current.generation;
    if (!text.trim() || answersDraft.isDirty) return false;
    const saved = await control.mutate("message", text.trim(), () => currentAt(generation));
    if (!saved) return false;
    const stillCurrent = currentAt(generation);
    const clean = messageDraft.acceptSaved("", undefined, text);
    if (stillCurrent && clean)
      control.setQuestionIndex((index) => Math.min(index + 1, Math.max(0, control.questions.length - 1)));
    return clean;
  }
  async function saveAnswers(): Promise<boolean> {
    const submitted = structuredClone(answersDraft.value),
      generation = live.current.generation;
    if (
      !answersDraft.isDirty ||
      answersDraft.hasRemoteChanges ||
      !submitted.kind ||
      !submitted.purpose?.trim() ||
      messageDraft.isDirty
    )
      return false;
    const patch = masonAnswerPatch(submitted);
    if (control.session?.answers.name && !patch.name) return false;
    const saved = await control.mutate("answers", patch, () => currentAt(generation));
    if (!saved) return false;
    const stillCurrent = currentAt(generation);
    const clean = answersDraft.acceptSaved(saved.answers, JSON.stringify(saved), submitted);
    return stillCurrent && clean;
  }
  function changeQuestion(index: number) {
    const generation = live.current.generation;
    leave.request(() => {
      if (currentAt(generation)) {
        live.current.generation++;
        control.invalidateReview();
        control.setQuestionIndex(index);
      }
    }, [messageDraft.key, answersDraft.key]);
  }
  return {
    ...control,
    identity,
    messageDraft,
    answersDraft,
    answerPatch: masonAnswerPatch(answersDraft.value),
    cannotClearName: Boolean(control.session?.answers.name && !answersDraft.value.name?.trim()),
    leave,
    changeMessage,
    changeAnswer,
    sendMessage,
    saveAnswers,
    changeQuestion,
    draftAndReview: () => {
      if (!messageDraft.isDirty && !answersDraft.isDirty) return control.draftAndReview();
    },
    canDraft: control.canDraft && !messageDraft.isDirty && !answersDraft.isDirty,
  };
}
