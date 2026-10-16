import { useLayoutEffect, useRef } from "react";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";

type BindingValue = { connectionId: string; target: string };
type BindingDraft = {
  key: string;
  inputVersion: number;
  value: BindingValue;
  isDirty: boolean;
  acceptSaved: (value: BindingValue, revision?: string | number, submitted?: BindingValue) => boolean;
};
type BindingOwner = NonNullable<MissionThreadedContextDockProps["contextMutations"]>["binding"];
type Submission = {
  key: string;
  inputVersion: number;
  scopeIdentity: string;
  raw: BindingValue;
  reviewed: BindingValue;
};

/** A canonical receipt acknowledges only the exact draft reviewed for that submission. */
export function useChatBindingDraftReceipt(
  draft: BindingDraft,
  saved: BindingValue,
  updatedAt: string | undefined,
  owner: BindingOwner | undefined,
) {
  const pending = useRef<Submission | undefined>(undefined);
  useLayoutEffect(() => {
    const submitted = pending.current;
    if (
      !submitted ||
      !draft.isDirty ||
      draft.key !== submitted.key ||
      draft.inputVersion !== submitted.inputVersion ||
      owner?.scopeIdentity !== submitted.scopeIdentity ||
      owner.phase !== "resolved" ||
      owner.receipt?.kind !== "external-binding" ||
      !owner.isCurrent() ||
      JSON.stringify(saved) !== JSON.stringify(submitted.reviewed)
    )
      return;
    pending.current = undefined;
    draft.acceptSaved(saved, updatedAt, submitted.raw);
  }, [draft, saved, updatedAt, owner]);
  return (reviewed: BindingValue) => {
    if (!owner) return;
    pending.current = {
      key: draft.key,
      inputVersion: draft.inputVersion,
      scopeIdentity: owner.scopeIdentity,
      raw: draft.value,
      reviewed,
    };
  };
}
