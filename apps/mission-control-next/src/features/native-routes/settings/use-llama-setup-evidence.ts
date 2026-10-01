import { useCallback, useEffect, useRef, useState } from "react";
import type { LlamaCppSetupProjection } from "@goatcitadel/contracts";
import { fetchChangePlan, fetchLlamaCppSetup } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { llamaProjectionReady, llamaScopeKey, rememberLlamaPlan, requireLlamaPlan } from "./llama-setup-state";

export function useLlamaSetupEvidence(workspaceId: string) {
  const installation = getGatewayApiBaseUrl(),
    key = llamaScopeKey(installation, workspaceId);
  const [value, setValue] = useState<{
    key: string;
    projection?: LlamaCppSetupProjection;
    loading: boolean;
    error?: string;
  }>({ key, loading: true });
  const life = useRef({ key, view: {}, epoch: 0, mounted: false, read: 0 });
  const request = useRef<AbortController | undefined>(undefined);
  if (life.current.key !== key) {
    life.current.key = key;
    life.current.view = {};
    life.current.epoch++;
  }
  const renderedView = life.current.view;
  useEffect(() => {
    const owner = life.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch++;
      request.current?.abort();
      request.current = undefined;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!workspaceId.trim() || !life.current.mounted || life.current.view !== renderedView
      || life.current.key !== key || getGatewayApiBaseUrl() !== installation) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const epoch = life.current.epoch,
      read = ++life.current.read;
    const current = () =>
      life.current.mounted &&
      life.current.view === renderedView &&
      request.current === controller && !controller.signal.aborted &&
      life.current.key === key &&
      life.current.epoch === epoch &&
      life.current.read === read &&
      getGatewayApiBaseUrl() === installation;
    setValue((previous) => ({
      key,
      projection: previous.key === key ? previous.projection : undefined,
      loading: true,
    }));
    try {
      const projection = await fetchLlamaCppSetup(workspaceId, controller.signal);
      if (!current()) return;
      if (!llamaProjectionReady(projection))
        throw new Error("The Gateway returned incomplete llama.cpp setup evidence.");
      setValue({ key, projection, loading: true });
      const latest = projection.pendingPlan ?? projection.recentPlan;
      if (latest) {
        const plan = await fetchChangePlan(latest.planId, { workspaceId });
        if (!current()) return;
        // The setup projection can also reference non-path configuration plans.
        if (plan.request?.kind === "runtime_configuration" && plan.request.change.operation === "llama_cpp_setup") {
          requireLlamaPlan(plan, workspaceId);
          if (plan.planId !== latest.planId || plan.revision < latest.revision)
            throw new Error("Setup history did not match the projected plan.");
          rememberLlamaPlan(installation, plan);
        }
      }
      if (current()) setValue({ key, projection, loading: false });
    } catch (error) {
      if (current())
        setValue((previous) => ({
          key,
          projection: previous.key === key ? previous.projection : undefined,
          loading: false,
          error: error instanceof Error ? error.message : "Setup evidence unavailable.",
        }));
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }, [installation, key, renderedView, workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return {
    installation,
    key,
    projection: value.key === key ? value.projection : undefined,
    loading: value.key !== key || value.loading,
    error: value.key === key ? value.error : undefined,
    refresh,
  };
}
