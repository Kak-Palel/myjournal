# Real Ollama responses (captured 2026-10-08)

Raw responses from a REAL **Ollama 0.40.1** (the official `ollama/ollama` Docker image, linux/amd64, extracted without Docker),
CPU only (4 cores, 16 GB), `OLLAMA_NUM_PARALLEL=1`, nothing else tuned. Models were imported from GGUF files (Ollama's
registry is not reachable from the sandbox): `llama3.2:1b` (Llama 3.2 1B Instruct Q8_0), `qwen3:1.7b` (Qwen3-1.7B Q4_K_M, template
with `.Thinking`, i.e. Ollama separates the reasoning) and `smollm2:360m` (SmolLM2-360M-Instruct Q4_K_M). Nothing here
contains credentials. `*.body` = exact response bytes, `*.headers.txt` = status line + headers. `test/providers/ollama-live.test.js`
replays all of it through the `local` adapter.

## What the captures show (everything below was observed, not assumed)

* **Streaming chunks** (`stream-success`): `Content-Type: text/event-stream`, frames are `data: {json}\n\n` (LF only). There is
  **no role-only first chunk**: the first delta is `{"role":"assistant","content":"Writing"}`. Every later delta is `{"content":" x"}`.
  The finish chunk has `"delta":{}` and `finish_reason` (`stop`, or `length` when `max_tokens` ran out). Then, only when
  `stream_options.include_usage` is true, a chunk with `"choices":[]`, `usage` (+ `prompt_tokens_details.cached_tokens`) and a
  **`timings` block** (`prompt_per_second`, `predicted_per_second` ...). Then `data: [DONE]`.
* **Parameters**: `max_tokens` is honoured (`stream-max-tokens-5-length`); **`max_completion_tokens` is ignored** (31 tokens came back for 5);
  `max_tokens: 0` yields exactly one token then `length`; `-1` means unlimited; unknown parameters, a bogus `stream_options`
  and `temperature: 9` are all accepted silently (HTTP 200).
* **Thinking models** (`qwen3-stream-thinking`, `qwen3-nonstream-thinking`): the reasoning arrives as **`delta.reasoning`**
  (not `reasoning_content`) next to `"content":""`, then the answer in `content`. Non-streamed: `message.reasoning`. With a
  30-token budget the reasoning eats everything: `finish_reason: "length"` and `content` never starts
  (`qwen3-stream-thinking-truncated`). **`reasoning_effort: "none"` switches thinking off** (`qwen3-stream-reasoning-none`: no reasoning
  frames, answer in ~1.7 s instead of 8-14 s); `"think": false` is ignored on `/v1`; `"low"` still thinks. For models that cannot think,
  `"none"` is harmless (HTTP 200) while `"high"` is a 400 `"llama3.2:1b" does not support thinking`.
* **Errors** (all `/v1` errors are OpenAI-shaped: `{"error":{"message","type","param":null,"code":null}}`):
  unknown model `404 {"error":{"message":"model 'nope:1b' not found","type":"not_found_error",...}}`;
  malformed JSON `400 "unexpected EOF"`; missing messages `400 "[] is too short - 'messages'"`; missing model `400 "model is required"`;
  **context overflow** `400` whose `message` is itself a JSON document (the runner's error:
  `request (7538 tokens) exceeds the available context size (4096 tokens), try increasing it`, with `n_prompt_tokens`, `n_ctx`);
  unknown path `404 page not found` (plain text); `GET /v1/chat/completions` -> `405 method not allowed` (`Allow: POST`);
  `GET /` -> `Ollama is running`. An unknown `role` is NOT an error.
* **Lists**: `GET /v1/models` is ordered newest-first, not alphabetically, `owned_by: "library"`; `GET /api/tags` carries
  `capabilities` (`completion`, `tools`, `thinking`) and `details.context_length`; `GET /api/version` -> `{"version":"0.40.1"}`;
  `GET /api/ps` while a model is loaded shows `context_length: 4096` (the real default window with no GPU: the server log says
  `vram-based default context ... default_num_ctx=4096`).
* **`/api/pull` with the registry unreachable** (`pull-unreachable-*`, `pull-offline-*`): HTTP 200 NDJSON `{"status":"pulling manifest"}`
  then `{"error":"pull model manifest: Get \"https://registry.ollama.ai/v2/library/llama3.2/manifests/3b\": Forbidden"}`
  (sandbox proxy policy) or `...: proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused` (simulated offline).
  Non-streaming: HTTP 500 with the same text. The word "manifest" appears although the model may exist; **even a model that is
  already installed asks the registry** (`pull-already-present`). Invalid names: `400 {"error":"invalid model name"}`.
  (The registry's own "no such model" text is `pull model manifest: file does not exist`; not reproducible here, assumed.)
* **Cannot load the model** (`error-model-too-big`: started with `OLLAMA_CONTEXT_LENGTH=131072 OLLAMA_NUM_PARALLEL=16`, i.e. a 64 GB KV cache):
  HTTP 500 `{"error":{"message":"llama-server process has terminated: exit status 1: ggml_aligned_malloc: insufficient memory (attempted to allocate
  65536.00 MB) ... failed to allocate buffer for kv cache","type":"api_error","param":null,"code":null}}`. Note `OLLAMA_CONTEXT_LENGTH` is capped at the
  model's own maximum (smollm2: 8192), so a huge value alone does not fail.
* **Aborts**: a client that disconnects mid-stream (or during prompt processing) makes Ollama cancel the task (runner CPU 0 % at once, the next
  request answered in ~0.4 s); a client that disconnects while the model is still LOADING cancels the load too
  (`client connection closed before llama-server finished loading, aborting load`), so a retry after a too-short timeout starts the load again.
* **Context window**: the default is 4096 tokens (CPU). Over the limit Ollama trims whole OLD messages and keeps the system
  message and the latest one (verified with a `PINEAPPLE` secret in the system prompt: still obeyed at 3775 prompt tokens after
  trimming), but a single latest message that alone does not fit is the 400 above (`error-context-overflow`).

Re-capture: start Ollama, then `curl -sS -D x.headers.txt -o x.body ...` as in `.scratch/live-local/cap.sh`.
