// Visual-only synthetic hardware. Real detection is covered by the surface and desktop lanes.
// Preserve failed/unavailable Gateway responses; successful local hardware reads are made
// deterministic so CI Linux and developer Windows machines compare the same visual state.
export function createVisualLocalAiReadiness() {
  return {
    hardware: {
      checkedAt: "2026-08-01T00:00:00.000Z",
      os: {platform:"linux",arch:"x64",release:"verification-fixture"},
      cpu: {model:"Verification CPU",logicalCores:4},
      memory: {totalBytes:16 * 1024 ** 3,freeBytes:8 * 1024 ** 3},
      gpu: [], disk:{modelsRootPath:"/verification/models",freeBytes:64 * 1024 ** 3},
      runtimes: ["ollama","llama_cpp","vllm","sglang"].map(backend=>({backend,detected:false,platformSupport:"native",notes:["Synthetic visual fixture: runtime not detected."]})),
    },
    catalog: [{modelId:"verification-local-model",label:"Verification local model",family:"verification",parameterCountBillions:3,quantization:"Q4_K_M",contextTokens:8192,preferredBackends:["llama_cpp"],tags:["visual-fixture"],source:"operator"}],
    recommendations: [{modelId:"verification-local-model",backend:"llama_cpp",fit:"good",confidence:"medium",reasons:["Synthetic 16 GiB hardware profile."],limitations:["Visual fixture only; no inference runtime was invoked."],estimatedMemoryBytes:3 * 1024 ** 3}],
    downloads: [], serveJobs: [], endpoints: [],
  };
}

export async function installVisualLocalAiFixture(page) {
  await page.route("**/api/v1/local-ai/readiness", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({response});
    const body = await response.json();
    const payload = body?.data && ("success" in body || "meta" in body) ? body.data : body;
    if (!payload?.hardware) return route.fulfill({response});
    const fixture = createVisualLocalAiReadiness();
    await route.fulfill({response,json:payload === body ? fixture : {...body,data:fixture}});
  });
}
