# Real Gemini API responses (captured 2026-10-08)

Raw responses from `generativelanguage.googleapis.com/v1beta` captured with a free-tier key, used as ground truth
for the Gemini adapter tests and the mock server (`test/mocks/mock-gemini.js`). Nothing here contains credentials.

* `*.body` — exact response bodies (SSE frames use `\r\n\r\n` separators); `*.headers.txt` — response headers.
* `stream-success*` — a normal streamed answer (2–3 frames; last frame carries `finishReason` + `usageMetadata`).
  `-with-thoughts` shows `thoughtsTokenCount` when the model thinks.
* `error-*` — error bodies: invalid key (400 `API_KEY_INVALID`), missing key (403), unknown model (404), retired model
  (404 "no longer available to new users"), unsupported `thinkingLevel: minimal` (400), invalid `thinkingBudget: 0` on 3.x (400),
  request ending with a model turn (400), empty input (400).
* `models-list.json` — trimmed `models.list` (public metadata). It includes many non-chat ids and retired chat models.

Not captured (could not be provoked): `429 RESOURCE_EXHAUSTED` with `RetryInfo`, `503 UNAVAILABLE "high demand"`
(seen once live: `{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}`).
