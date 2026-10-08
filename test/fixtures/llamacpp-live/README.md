# Real llama.cpp `llama-server` responses (captured 2026-10-08)

Raw responses from the REAL llama.cpp server that ships inside the Ollama 0.40.1 image (`lib/ollama/llama-server`,
`version: 0.5.0-dev (build 1, commit 631109b34)`), started as
`llama-server -m qwen3-1.7b-q4km.gguf -c 4096 --jinja` (plus `--reasoning-format none` for the `*inline-think*` captures, and
`-m smollm2-360m-q4km.gguf --api-key ...` on a second port for the `error-401-*` ones). CPU only. Nothing here contains real
credentials (the API key used was a throwaway). `test/providers/llamacpp-live.test.js` replays all of it.

## What the captures show

* Chunks are `data: {json}\n\n` with the JSON keys in a different order than OpenAI's, `Server: llama.cpp`, and **the first delta is
  `{"role":"assistant","content":null}`**. The usage chunk has `"choices":[]` plus `usage` and a `timings` block (`cache_n`,
  `prompt_per_second`, `predicted_per_second`). `system_fingerprint` is the build id (`b1-631109b34`).
* **Reasoning** (`stream-thinking`): with `--jinja` and the default reasoning format the thoughts arrive as
  `delta.reasoning_content` (no `content` key at all while thinking). With `--reasoning-format none` (`stream-inline-think`) the
  thoughts are INLINE in `content`: `<think>\n...\n</think>\n\nAnswer`. `reasoning_effort: "none"` works here too
  (`stream-reasoning-none`: ~1.2 s instead of ~8 s; the template still emits an empty `<think>\n\n</think>\n\n` pair in
  inline mode). `chat_template_kwargs: {"enable_thinking": false}` also works, `"low"` still thinks.
* **`GET /v1/models`**: both `models` (Ollama-style) and `data` (OpenAI-style). The model id is the **path of the GGUF file** and
  `data[0].meta.n_ctx` tells the real context window (4096 here). `GET /health` -> `{"status":"ok"}`; `/api/version` and `/` are
  `404 {"error":{"message":"File Not Found","type":"not_found_error","code":404}}`. The default port is still 8080, but the
  start-up log warns that it "will be changed to :9931 in a future release".
* **Any model name is accepted** (`error-model-unknown` is HTTP 200). Errors are `{"error":{"code","message","type"}}`:
  malformed JSON `400` with a nlohmann parse_error text, no messages `400 "'messages' is required"`, context overflow
  `400 exceed_context_size_error` with `n_prompt_tokens` and `n_ctx` directly in the error object,
  `--api-key`: `401 {"error":{"message":"Invalid API Key","type":"authentication_error","code":401}}` (also for `GET /v1/models`;
  `GET /health` stays open).
