import { useEffect, useRef, useState } from "react";
import type { McpServerTemplateRecord } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayAccessRevision, getGatewayCallerScope, subscribeGatewayAccessChange, subscribeGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { createMcpFormFromTemplate, type McpCreateForm } from "./sections/mcp-editor-drafts";

/** Replacing input is not leaving it: preservation must never run the setter. */
export function useMcpTemplateReplacement({ workspaceId, draft, templates, available, isTemplateCurrent }: {
  workspaceId: string;
  draft: { key: string; value: McpCreateForm; inputVersion: number; isDirty: boolean; setValue: (value: McpCreateForm) => void };
  templates: McpServerTemplateRecord[];
  available: boolean;
  isTemplateCurrent: (template: McpServerTemplateRecord) => boolean;
}) {
  const gateway = getGatewayApiBaseUrl(), caller = getGatewayCallerScope(), access = getGatewayAccessRevision();
  const signature = JSON.stringify([gateway, caller, access, workspaceId, draft.key, draft.inputVersion, draft.value, templates, available]);
  const binding = useRef({ signature });
  if (binding.current.signature !== signature) binding.current = { signature };
  const token = binding.current;
  const [review, setReview] = useState<{ token: typeof token; template: McpServerTemplateRecord } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => { binding.current = { signature: "invalidated" }; setReview(null); };
    const callerUnsubscribe = subscribeGatewayCallerScope(invalidate);
    const accessUnsubscribe = subscribeGatewayAccessChange(invalidate);
    return () => { mounted.current = false; callerUnsubscribe(); accessUnsubscribe(); };
  }, []);
  const current = () => mounted.current && available && token === binding.current
    && gateway === getGatewayApiBaseUrl() && caller === getGatewayCallerScope() && access === getGatewayAccessRevision();
  return {
    replacement: review?.token === token ? review.template : null,
    cancel: () => setReview(null),
    request: (template: McpServerTemplateRecord) => {
      if (!current() || !templates.includes(template) || !isTemplateCurrent(template)) return;
      if (draft.isDirty) setReview({ token, template: structuredClone(template) });
      else draft.setValue(createMcpFormFromTemplate(template));
    },
    confirm: () => {
      if (review?.token === token && current() && isTemplateCurrent(review.template)) draft.setValue(createMcpFormFromTemplate(review.template));
      setReview(null);
    },
  };
}
