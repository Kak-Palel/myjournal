# Real Gemini API responses (captured 2026-10-08)

Raw responses from `generativelanguage.googleapis.com/v1beta` captured with a free-tier key, used as ground truth
for the Gemini adapter tests and the mock server (`test/mocks/mock-gemini.js`). Nothing here contains credentials.

* `*.body` — exact response bodies (SSE frames use `\r\n\r\n` separators); `*.headers.txt` — response headers.
* `stream-success*` — a normal streamed answer (2–3 frames; last frame carries `finishReason` + `usageMetadata`).
  `-with-thoughts` shows `thoughtsTokenCount` when the model thinks.
* `error-*` — error bodies: invalid key (400 `API_KEY_INVALID`), missing key (403), unknown model (404), retired model
  (404 "no longer available to new users"), unsupported `thinkingLevel: minimal` on gemini-3.8-flash (400), any `thinkingLevel` on
  gemma-4 and gemini-2.5 models (400 "Thinking level is not supported for this model."; `error-thinking-level-unsupported`),
  invalid `thinkingBudget: 0` on 3.x (400), request ending with a model turn (400), empty input (400) and
  `error-overloaded-503` (503 UNAVAILABLE "high demand", captured from `gemini-flash-latest`).
  Every error on `:streamGenerateContent` except the two key errors comes back as `content-type: text/event-stream` with a plain pretty-printed JSON body.
* `models-list.json` — trimmed `models.list` (public metadata). It includes many non-chat ids and retired chat models
  (`gemini-2.5-flash` and `gemini-2.5-pro` are still listed but answer 404 "no longer available").

## Live behaviour measured on 2026-10-08 (free tier, prompts of the journal app)

| model | first byte | thought tokens (auto / `thinkingLevel: low`) | notes |
|---|---|---|---|
| `gemini-flash-lite-latest` (= gemini-3.5-flash-lite) | 0.5-1.4 s (one 13 s outlier) | 0 / ~465 | `low` turns thinking ON: slower (2.3 s), not faster. `minimal` accepted. |
| `gemini-3.5-flash` | 4.0-4.5 s auto, 2.1-2.9 s low | ~810 / ~350 | |
| `gemini-flash-latest` (= gemini-3.8-flash) | 503 after 1-3 s on all 3 `auto` requests; 23 s on the one `low` request that succeeded | 69-286 on low | the whole answer arrives in one burst (3 frames within 2 ms) |
| `gemma-4-26b-a4b-it` | ~7 s (one sample) | ~290 on auto; `low` is rejected | rejects any `thinkingLevel`; accepts `systemInstruction` |
| `gemini-2.5-flash-lite` | 1.6 s | 0 | rejects `thinkingLevel`, accepts `thinkingBudget: 0` |

A journal reply (2-4 sentences, ~250 characters) streams as 3-5 frames within 150-400 ms; a 900-word answer streams as ~45 frames
about 90 ms apart. `usageMetadata.candidatesTokenCount` excludes thoughts, `totalTokenCount` includes them.

Not captured (could not be provoked): `429 RESOURCE_EXHAUSTED` with `RetryInfo`.
