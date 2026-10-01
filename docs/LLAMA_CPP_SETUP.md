# Set up llama.cpp for Chat

Open **Settings → Models → Get started → Set up llama.cpp**.

1. Choose **Use a running server** to connect to a server you operate. Enter its OpenAI-compatible `/v1` URL, check the endpoint, and choose a model freshly returned by `/v1/models`. GoatCitadel does not start or stop an external server. A saved launch command or GGUF path from an older configuration does not change that ownership rule.
2. Choose **Let GoatCitadel start one** to use an already installed `llama-server` and a GGUF discovered under the configured models root. The Gateway holds the selected executable and GGUF paths behind a short-lived selection ID. It revalidates both files before applying the setup. Managed setup starts the process now and enables start with the Gateway. A server already occupying that URL is reported as a conflict and is not touched.
3. Select **Finish setup**, review the single Change Plan approval in the same flow, then approve it. The Gateway rereads the canonical decision and applies the exact plan once. Denied or expired approvals do not apply. A plan left awaiting approval is recovered after a Gateway restart. The Ops approval detail includes a return link to setup.
4. Select **Send test message**. The Gateway creates a hidden diagnostic Chat session with tools, web, memory, and delegation off. It reports the effective provider and model, response excerpt, latency, settings revision, and trace reference. A model-list probe alone does not count as a Chat test. If settings change, the earlier test result is stale.

The setup projection is `GET /api/v1/llamacpp/setup`. Managed file choices use `POST /api/v1/llamacpp/setup/managed-selection`; the returned opaque ID, not host paths, goes into the `llama_cpp_setup` Change Plan. The Chat diagnostic uses `POST /api/v1/llamacpp/setup/chat-test`.

Local AI jobs and endpoints have their own registry. An empty Local AI registry does not establish whether the llama.cpp Chat provider works. The optional NPU sidecar does not prove local inference readiness.
