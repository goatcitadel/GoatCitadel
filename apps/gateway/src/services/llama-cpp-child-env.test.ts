import { describe, expect, it } from "vitest";
import { buildLlamaCppChildEnv } from "./llama-cpp-runtime-service.js";

describe("buildLlamaCppChildEnv", () => {
  it("keeps OS basics and GPU variables but drops provider keys and gateway secrets", () => {
    const env = buildLlamaCppChildEnv({
      Path: "/x",
      SystemRoot: "/x",
      TEMP: "/x",
      CUDA_VISIBLE_DEVICES: "0",
      GGML_VK_VISIBLE_DEVICES: "1",
      LLAMA_ARG_THREADS: "4",
      HIP_VISIBLE_DEVICES: "0",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      GOATCITADEL_AUTH_TOKEN: "token",
    });
    expect(env).toEqual({
      Path: "/x",
      SystemRoot: "/x",
      TEMP: "/x",
      CUDA_VISIBLE_DEVICES: "0",
      GGML_VK_VISIBLE_DEVICES: "1",
      LLAMA_ARG_THREADS: "4",
      HIP_VISIBLE_DEVICES: "0",
    });
  });
});
