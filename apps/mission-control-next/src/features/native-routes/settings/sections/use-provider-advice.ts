import { useEffect, useRef, useState } from "react";
import { fetchLlmProviderAdvice } from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage, type LoadState } from "../SettingsShared";

export function useProviderAdvice() {
  const [state, setState] = useState<LoadState<Awaited<ReturnType<typeof fetchLlmProviderAdvice>>>>({
    loading: false,
    data: null,
    error: null,
  });
  const generation = useRef(0);
  useEffect(() => {
    const owner = generation;
    return () => {
      owner.current++;
    };
  }, []);
  const load = async () => {
    const id = ++generation.current;
    setState({ loading: true, data: null, error: null });
    try {
      const data = await fetchLlmProviderAdvice({
        preference: "runtime_fit",
        taskHint: "general GoatCitadel chat, code, and orchestration routing",
        maxCandidates: 5,
      });
      if (id === generation.current) setState({ loading: false, error: null, data });
    } catch (error) {
      if (id === generation.current) setState({ loading: false, data: null, error: getErrorMessage(error) });
    }
  };
  return { state, load };
}
