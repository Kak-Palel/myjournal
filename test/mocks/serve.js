// Start both mock LLM servers for manual UI trials:  npm run mock-llm
//
//   OpenAI-compatible + Ollama API   http://127.0.0.1:11500
//   Gemini API                       http://127.0.0.1:11501
//
// Options:  --delay <ms>    pause between streamed chunks (default 35, so streaming is visible)
//           --think         wrap every reply in a <think> block, to see it being stripped
//           --openai-port N / --gemini-port N   (or env MOCK_OPENAI_PORT / MOCK_GEMINI_PORT)

import { LIVE_MODELS, createMockGemini } from './mock-gemini.js';
import { createMockOpenAI } from './mock-openai.js';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const delayMs = Number(option('delay', 35));
const think = process.argv.includes('--think');
const openaiPort = Number(option('openai-port', process.env.MOCK_OPENAI_PORT || 11500));
const geminiPort = Number(option('gemini-port', process.env.MOCK_GEMINI_PORT || 11501));

const openai = await createMockOpenAI({
  port: openaiPort,
  delayMs,
  think,
  models: ['llama3.2:3b', 'llama3.2:1b', 'qwen2.5:1.5b', 'gemma2:2b', 'smollm2:1.7b'],
  pull: { delayMs: 120, steps: 12 },
});
const gemini = await createMockGemini({
  port: geminiPort,
  delayMs,
  apiKey: ['mock-key'],
  models: [...LIVE_MODELS], // the real catalogue, non-chat models and all, so "Load models" shows what users will see
});

console.log(`
MyJournal mock LLM servers are running (Ctrl+C to stop). Nothing here is a real model:
replies are canned, deterministic and shaped like the real thing, so you can try the whole app offline.

  1) Local model (Ollama-style)         Settings -> Local model
       Base URL : ${openai.baseUrl}
       Model    : llama3.2:3b          (no API key needed; "Download model" works too)

  2) OpenAI-compatible API              Settings -> OpenAI-compatible
       Base URL : ${openai.baseUrl}
       Model    : mock-model           API key: anything

  3) Free Gemini API                    Settings -> Gemini
       Base URL : ${gemini.url}
       Model    : gemini-flash-lite-latest  API key: mock-key
       (any other key is rejected with Google's real "API key not valid" error, handy for seeing that UI)

Or through the environment before \`npm start\`:
  LOCAL_LLM_BASE_URL=${openai.baseUrl} LOCAL_LLM_MODEL=llama3.2:3b
  OPENAI_BASE_URL=${openai.baseUrl} OPENAI_API_KEY=mock-key
  GEMINI_API_KEY=mock-key   (then set the Gemini base URL to ${gemini.url} in Settings)

Streaming delay: ${delayMs} ms per chunk${think ? '; replies include <think> blocks' : ''}.
`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([openai.close(), gemini.close()]);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
