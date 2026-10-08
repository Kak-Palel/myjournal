// Pure logic behind the Settings screen (no DOM): tab routing, dirty detection, patch building, key status
// wording, "what to try next" hints for failed connections, progress parsing for model downloads and
// import-file validation. Kept DOM-free so it can be unit tested in Node.

/* ------------------------------------------------------------------- tabs */
export const SETTINGS_TABS = Object.freeze([
  { id: 'gemini', label: 'Gemini (free)', provider: true },
  { id: 'openai', label: 'OpenAI-compatible', provider: true },
  { id: 'local', label: 'Local model', provider: true },
  { id: 'general', label: 'General' },
  { id: 'data', label: 'Data' },
]);
export const PROVIDER_IDS = Object.freeze(['gemini', 'openai', 'local']);

/** Short names used in sentences ("Now using Gemini"). */
export const PROVIDER_NAMES = Object.freeze({ gemini: 'Gemini', openai: 'OpenAI-compatible API', local: 'Local model' });

/**
 * Which tab to open. `?tab=` wins when valid; otherwise the active provider's tab, else Gemini
 * (the quickest way to get going).
 */
export function resolveTab(requested, activeProvider = '') {
  if (SETTINGS_TABS.some((t) => t.id === requested)) return requested;
  return PROVIDER_IDS.includes(activeProvider) ? activeProvider : 'gemini';
}

/** Hash for a tab, keeping the onboarding `setup=1` flag. */
export function tabHash(tabId, { setup = false } = {}) {
  return `#/settings?tab=${encodeURIComponent(tabId)}${setup ? '&setup=1' : ''}`;
}

/* ----------------------------------------------------------------- limits */
/** Mirrors SETTINGS_LIMITS in src/settings.js (the server clamps/validates again). */
export const LIMITS = Object.freeze({
  nameMax: 80,
  aboutMax: 1000,
  customMax: 1500,
  temperature: Object.freeze({ min: 0, max: 2 }),
  maxTokens: Object.freeze({ min: 64, max: 8192 }),
  contextBudgetTokens: Object.freeze({ min: 500, max: 32000 }),
  timeoutSec: Object.freeze({ min: 5, max: 600 }),
});

/** Step of the creativity slider. */
export const TEMPERATURE_STEP = 0.05;

/**
 * What the slider shows for a saved temperature. The server accepts any number from 0 to 2, but a range input
 * snaps to its step (0.33 reads back as 0.35), so "unchanged" has to be judged against the snapped value or the
 * form would claim unsaved changes forever.
 */
export function snapTemperature(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  const { min, max } = LIMITS.temperature;
  const steps = Math.round(1 / TEMPERATURE_STEP);
  return Math.round(Math.min(max, Math.max(min, n)) * steps) / steps;
}

/** Largest import file the server accepts (ARCHITECTURE section 6). */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/**
 * Clamp a typed number into limits. Returns null when the text is not a number.
 * @returns {{ value: number, clamped: boolean } | null}
 */
export function clampNumber(raw, { min, max }, { integer = false } = {}) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const rounded = integer ? Math.round(n) : Math.round(n * 100) / 100;
  const value = Math.min(max, Math.max(min, rounded));
  return { value, clamped: value !== rounded };
}

/* -------------------------------------------------------------- api keys */
const ENV_NAMES = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', local: 'LOCAL_LLM_API_KEY' };

/** Environment variable that can supply a provider's key. */
export function envKeyName(providerId) {
  return ENV_NAMES[providerId] || 'an environment variable';
}

/**
 * How to describe the API key situation without ever showing a key.
 * @param {{ apiKeySet?: boolean, apiKeyHint?: string, apiKeySource?: string }} saved public provider settings
 * @param {string} providerId
 * @returns {{ kind: 'saved'|'env'|'none', text: string, placeholder: string, canRemove: boolean }}
 */
export function keyStatus(saved, providerId) {
  const set = Boolean(saved && saved.apiKeySet);
  const source = saved && saved.apiKeySource;
  const hint = saved && typeof saved.apiKeyHint === 'string' ? saved.apiKeyHint : '';
  if (set && source === 'env') {
    const name = envKeyName(providerId);
    return { kind: 'env', text: `Using ${name} from the environment`, placeholder: `Using ${name} - paste a key to override it`, canRemove: false };
  }
  if (set) {
    const tail = hint ? ` ending ${hint}` : '';
    return { kind: 'saved', text: `Saved key${tail}`, placeholder: hint ? `Saved key ${hint} - type to replace it` : 'Saved - type to replace it', canRemove: true };
  }
  return { kind: 'none', text: 'No key saved yet', placeholder: providerId === 'gemini' ? 'Paste your Gemini API key' : 'Paste your API key', canRemove: false };
}

/* --------------------------------------------------------- provider forms */
const stripSlashes = (url) => String(url || '').trim().replace(/\/+$/, '');
const thinkingValue = (v) => (v === 'low' ? 'low' : 'auto');

/**
 * Differences between the form and what is saved, as a provider settings patch. Only changed fields are
 * included; `apiKey` appears only when the user typed one (the saved key is never prefilled).
 * @param {{ baseUrl: string, model: string, apiKey?: string, thinking?: string }} form
 * @param {{ baseUrl?: string, model?: string, thinking?: string }} saved
 */
export function providerChanges(form, saved, providerId) {
  const out = {};
  if (stripSlashes(form.baseUrl) !== stripSlashes(saved.baseUrl)) out.baseUrl = String(form.baseUrl || '').trim();
  if (String(form.model || '').trim() !== String(saved.model || '').trim()) out.model = String(form.model || '').trim();
  if (providerId === 'gemini' && thinkingValue(form.thinking) !== thinkingValue(saved.thinking)) out.thinking = thinkingValue(form.thinking);
  const key = String(form.apiKey || '').trim();
  if (key) out.apiKey = key;
  return out;
}

/**
 * Settings patch for "Save" / "Use this provider".
 * @returns {object|null} null when there is nothing to send
 */
export function buildProviderPatch(providerId, form, saved, { activate = false } = {}) {
  const changes = providerChanges(form, saved, providerId);
  const ai = {};
  if (Object.keys(changes).length) ai.providers = { [providerId]: changes };
  if (activate) {
    ai.provider = providerId;
    ai.enabled = true;
  }
  return Object.keys(ai).length ? { ai } : null;
}

/** Unsaved config sent with Test connection / Load models so people can try before saving. */
export function overlayConfig(form) {
  const out = {};
  const baseUrl = String(form.baseUrl || '').trim();
  const model = String(form.model || '').trim();
  const apiKey = String(form.apiKey || '').trim();
  if (baseUrl) out.baseUrl = baseUrl;
  if (model) out.model = model;
  if (apiKey) out.apiKey = apiKey;
  return out;
}

/**
 * Fingerprint of the connection a Test / Load models request was built from. Comparing the fingerprint taken
 * when the request started with the one taken when the answer arrives tells whether the person has edited the
 * form in between (the answer then describes a configuration that is no longer on screen).
 * @param {{ baseUrl?: string, model?: string, apiKey?: string }} form
 * @param {{ model?: boolean }} [opts] `model: false` for the models list, which does not depend on the model name
 */
export function connectionKey(form, { model = true } = {}) {
  const o = overlayConfig(form);
  return JSON.stringify(model ? [o.baseUrl || '', o.model || '', o.apiKey || ''] : [o.baseUrl || '', o.apiKey || '']);
}

/**
 * Sort server `fields` ({ 'ai.providers.openai.baseUrl': 'must be ...' }) into per-control messages.
 * Anything that is not a recognised control ends up in `other` so it is never silently dropped.
 */
export function mapProviderErrors(fields, providerId) {
  const out = { other: [] };
  if (!fields || typeof fields !== 'object') return out;
  for (const [path, message] of Object.entries(fields)) {
    const m = /(?:^|\.)providers\.(gemini|openai|local)\.(baseUrl|model|apiKey|thinking)$/.exec(path);
    if (m && m[1] === providerId) out[m[2]] = String(message);
    else out.other.push(`${path}: ${message}`);
  }
  return out;
}

const GENERAL_PATHS = {
  'profile.name': 'name',
  'profile.about': 'about',
  'persona.id': 'persona',
  'persona.custom': 'custom',
  'ai.enabled': 'enabled',
  'ai.temperature': 'temperature',
  'ai.maxTokens': 'maxTokens',
  'ai.contextBudgetTokens': 'contextBudgetTokens',
  'ai.timeoutSec': 'timeoutSec',
};

/** Same idea for the General tab. */
export function mapGeneralErrors(fields) {
  const out = { other: [] };
  if (!fields || typeof fields !== 'object') return out;
  for (const [path, message] of Object.entries(fields)) {
    const control = GENERAL_PATHS[path];
    if (control) out[control] = String(message);
    else out.other.push(`${path}: ${message}`);
  }
  return out;
}

/**
 * Settings patch for the General tab: changed fields only.
 * @param {object} form  { name, about, persona, custom, enabled, temperature, maxTokens, contextBudgetTokens, timeoutSec }
 * @param {object} settings public settings
 * @returns {object|null}
 */
export function buildGeneralPatch(form, settings) {
  const patch = {};
  const put = (group, key, value) => { (patch[group] ||= {})[key] = value; };
  if (form.name.trim() !== settings.profile.name) put('profile', 'name', form.name.trim());
  if (form.about.trim() !== settings.profile.about) put('profile', 'about', form.about.trim());
  if (form.persona !== settings.persona.id) put('persona', 'id', form.persona);
  if (form.custom.trim() !== settings.persona.custom) put('persona', 'custom', form.custom.trim());
  for (const key of ['enabled', 'temperature', 'maxTokens', 'contextBudgetTokens', 'timeoutSec']) {
    const current = key === 'temperature' ? snapTemperature(settings.ai[key]) : settings.ai[key];
    if (form[key] !== current) put('ai', key, form[key]);
  }
  return Object.keys(patch).length ? patch : null;
}

/* ---------------------------------------------------------------- models */
/** Case-insensitive filter over loaded models, capped so a 400-model router cannot flood the page. */
export function filterModels(models, query, limit = 150) {
  const q = String(query || '').trim().toLowerCase();
  const all = Array.isArray(models) ? models : [];
  const matches = q ? all.filter((m) => `${m.id} ${m.label || ''}`.toLowerCase().includes(q)) : all;
  return { shown: matches.slice(0, limit), hidden: Math.max(0, matches.length - limit), total: all.length };
}

/** Unique suggestions + loaded models for the datalist (suggestions first). */
export function mergeModelOptions(suggested, loaded) {
  const seen = new Set();
  const out = [];
  for (const m of [...(suggested || []), ...(loaded || [])]) {
    if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, label: m.label || m.id });
  }
  return out;
}

const SMALL_MODELS = {
  'llama3.2:1b': { size: '1.3 GB', tier: 'For testing', blurb: 'Tiny and quick. Perfect for checking that everything is connected; replies stay basic.' },
  'qwen2.5:1.5b': { size: '1 GB', tier: 'Basic', blurb: 'Small and multilingual. Fine for short check-ins.' },
  'gemma2:2b': { size: '1.6 GB', tier: 'Good', blurb: 'Clear, friendly writing for its size.' },
  'llama3.2:3b': { size: '2 GB', tier: 'Better', blurb: 'Noticeably better follow-up questions. A good default with 8 GB of RAM.' },
  'smollm2:1.7b': { size: '1.8 GB', tier: 'Basic', blurb: 'Compact and light on older laptops.' },
};

/** Size / quality / blurb for a suggested local model, falling back to the catalog's own note. */
export function describeSmallModel(model) {
  const known = SMALL_MODELS[model.id];
  return { size: known ? known.size : '', tier: known ? known.tier : '', blurb: known ? known.blurb : (model.note || '') };
}

/* ----------------------------------------------------------------- hints */
/** A model name is only put in a copy-able shell command when it cannot do anything surprising. */
export function safeModelArg(model) {
  const m = String(model || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(m) ? m : '<model-name>';
}

/** Copy-able commands for the Ollama quick start. */
export function ollamaCommands(model) {
  return {
    serve: 'ollama serve',
    pull: `ollama pull ${safeModelArg(model)}`,
    context: 'OLLAMA_CONTEXT_LENGTH=8192 ollama serve',
    contextWindows: '$env:OLLAMA_CONTEXT_LENGTH=8192; ollama serve',
  };
}

/** Where a base URL points: this machine, the local network or the open internet. */
export function hostKind(url) {
  let host;
  try { host = new URL(String(url).trim()).hostname.toLowerCase(); } catch { return 'invalid'; }
  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // 127.x must be a complete dotted quad: "127.evil.com" is an ordinary public name that merely starts with 127.
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host) || host === '0.0.0.0') return 'loopback';
  if (host === 'host.docker.internal' || host.endsWith('.local') || host.endsWith('.lan')) return 'private';
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return 'private';
  }
  return 'remote';
}

/** One line of hint under the base URL for the preset that is currently typed. */
export const PRESET_HINTS = Object.freeze({
  openai: 'OpenAI. Create a key at platform.openai.com.',
  openrouter: 'OpenRouter gives one key for many models. Model names look like openai/gpt-4o-mini.',
  groq: 'Groq has a free tier with very fast replies.',
  together: 'Together AI hosts many open models.',
  ollama: 'Ollama listens on port 11434. No key needed.',
  llamacpp: 'llama.cpp\'s llama-server listens on port 8080. The model name can be anything it accepts.',
  lmstudio: 'LM Studio: start the Local Server tab first. Use Load models to see what is loaded.',
});

/** Presets the server did not provide (older servers) - same list as ARCHITECTURE section 9. */
export const FALLBACK_PRESETS = Object.freeze({
  openai: [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
    { id: 'together', label: 'Together', baseUrl: 'https://api.together.xyz/v1' },
  ],
  local: [
    { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
    { id: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1' },
    { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  ],
  gemini: [],
});

/** The preset whose URL matches what is typed (ignoring trailing slashes), or null. */
export function matchPreset(presets, baseUrl) {
  const url = stripSlashes(baseUrl).toLowerCase();
  return (presets || []).find((p) => stripSlashes(p.baseUrl).toLowerCase() === url) || null;
}

/**
 * Provider-specific next steps for a failed connection test.
 * @returns {Array<{ text: string, command?: string }>}
 */
export function nextSteps(providerId, code, { model = '' } = {}) {
  const steps = [];
  const add = (text, command) => steps.push(command ? { text, command } : { text });
  const m = safeModelArg(model);

  if (providerId === 'gemini') {
    switch (code) {
      case 'auth':
        add('Create a free key in Google AI Studio (aistudio.google.com/apikey).');
        add('Paste the whole key - nothing before or after it.');
        add('If you restricted the key in Google Cloud, allow the Generative Language API.');
        break;
      case 'rate_limit':
        add('The free tier allows only a few requests per minute. Wait a minute, then test again.');
        add('gemini-flash-lite-latest has the most generous free allowance.');
        break;
      case 'quota':
        add('The free daily allowance is used up. It resets once a day, or you can enable billing for the key\'s project.');
        add('gemini-flash-lite-latest has the most generous free allowance.');
        break;
      case 'model_not_found':
        add('Press Load models and pick one from the list, or choose gemini-flash-lite-latest.');
        break;
      case 'overloaded':
      case 'server':
        add('Google is busy right now. Wait a moment and test again.');
        add('gemini-flash-lite-latest is rarely overloaded; try it if this keeps happening.');
        break;
      case 'region':
        add('The free Gemini tier is not offered everywhere. The OpenAI-compatible and Local tabs work in any country.');
        break;
      case 'network':
      case 'timeout':
        add('Check your internet connection.');
        add('Behind a proxy? Start MyJournal with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY set.');
        break;
      case 'blocked':
        add('Gemini declined the test message. Try again, or pick another model.');
        break;
      default:
    }
  } else if (providerId === 'openai') {
    switch (code) {
      case 'auth':
        add('Check that the key is complete and was created for the service in the base URL.');
        add('An OpenRouter, Groq or Together key only works with its own base URL - use the preset buttons.');
        break;
      case 'quota':
        add('Your account is out of credit. Add credit or billing with the provider.');
        break;
      case 'rate_limit':
        add('The service is limiting requests. Wait a minute and try again.');
        break;
      case 'model_not_found':
        add('Press Load models and pick a model your service offers.');
        break;
      case 'bad_base_url':
        add('The address usually ends with /v1, for example https://api.openai.com/v1.');
        add('The preset buttons fill in the common ones.');
        break;
      case 'network':
      case 'timeout':
        add('Check the base URL for typos, and your internet connection.');
        break;
      case 'context_too_long':
        add('Lower the context budget on the General tab.');
        break;
      default:
    }
  } else if (providerId === 'local') {
    switch (code) {
      case 'network':
        add('Is your model server running? For Ollama, start it with:', 'ollama serve');
        add('Check the address. Ollama uses http://localhost:11434/v1 (use the Ollama preset).');
        add('MyJournal inside Docker? Use http://host.docker.internal:11434/v1 instead of localhost.');
        break;
      case 'model_not_found':
        add('The server does not have that model yet. Download it:', `ollama pull ${m}`);
        add('Or use the Download model button below.');
        break;
      case 'timeout':
        add('The first request after starting loads the model into memory and can take a minute. Try again.');
        add('Raise the timeout on the General tab, or choose a smaller model.');
        break;
      case 'bad_base_url':
        add('Ollama: http://localhost:11434/v1 - llama.cpp: http://localhost:8080/v1 - LM Studio: http://localhost:1234/v1.');
        break;
      case 'context_too_long':
        add('Give Ollama a bigger context window and restart it:', 'OLLAMA_CONTEXT_LENGTH=8192 ollama serve');
        add('Or lower the context budget on the General tab.');
        break;
      case 'empty':
        add('The model sent nothing back. Reasoning models can use their whole budget thinking: raise max tokens on the General tab or pick a non-reasoning model.');
        break;
      case 'auth':
        add('Your server wants a key. Put it in the API key field.');
        break;
      case 'server':
        add('The server answered with an error. Check its terminal - running out of memory is common with bigger models.');
        break;
      default:
    }
  }
  if (steps.length === 0 && code === 'rate_limit') add('Wait a minute, then test again.');
  return steps;
}

/* ------------------------------------------------------------ downloads */
/** "1.3 GB", "420 MB", "12 kB". Decimal units, like the model sizes people see in catalogs. */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1000) return `${Math.round(v)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = v / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i += 1; }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** "3.4 MB" for files, in the 1024-based units operating systems show (the import limit is 50 MiB). */
export function formatFileSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = v / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * Turn a pull `progress` event into something to show.
 * @param {{ status?: string, completed?: number, total?: number, percent?: number }} ev
 * @returns {{ percent: number|null, label: string, detail: string }}
 */
export function pullProgress(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const status = typeof e.status === 'string' ? e.status.trim().slice(0, 120) : '';
  let percent = null;
  if (Number.isFinite(e.percent)) percent = Math.min(100, Math.max(0, e.percent));
  else if (Number.isFinite(e.completed) && Number.isFinite(e.total) && e.total > 0) percent = Math.min(100, Math.max(0, (e.completed / e.total) * 100));
  let label = status || 'Working';
  if (/^pulling manifest/i.test(status)) label = 'Preparing the download';
  else if (/^pulling [0-9a-f]{6,}/i.test(status) || /^downloading/i.test(status)) label = 'Downloading';
  else if (/verifying/i.test(status)) label = 'Verifying the download';
  else if (/writing manifest|removing any unused/i.test(status)) label = 'Finishing up';
  else if (/^success$/i.test(status)) label = 'Done';
  const detail = Number.isFinite(e.completed) && Number.isFinite(e.total) && e.total > 0 ? `${formatBytes(e.completed)} of ${formatBytes(e.total)}` : '';
  return { percent, label, detail };
}

/** Message for a failed download, with the llama.cpp / LM Studio explanation for 409 not_ollama. */
export function describePullFailure(err) {
  const code = err && err.code;
  if (code === 'not_ollama') {
    return {
      message: 'This server is not Ollama, so MyJournal cannot download models for it.',
      hint: 'Downloading only works with Ollama. With llama.cpp or LM Studio, load a model in that app, then press Load models here.',
    };
  }
  return { message: (err && err.message) || 'The download failed.', hint: (err && err.hint) || 'Check that Ollama is running, then try again.' };
}

/* --------------------------------------------------------------- import */
/**
 * Validate a parsed export file before uploading it. The server validates again; this only produces the
 * friendly preview ("42 entries, 5 memories") and rejects obviously wrong files early.
 * @returns {{ ok: true, entries: number, messages: number, memories: number, reports: number, exportedAt: string }
 *   | { ok: false, problem: string }}
 */
export function summarizeImport(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, problem: 'That file is not a MyJournal export.' };
  if (doc.app !== 'myjournal') return { ok: false, problem: 'That file is not a MyJournal export (it is missing the "myjournal" marker).' };
  if (!Array.isArray(doc.entries)) return { ok: false, problem: 'The export has no entries list.' };
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  const messages = doc.entries.reduce((sum, e) => sum + (e && typeof e === 'object' ? count(e.messages) : 0), 0);
  return {
    ok: true,
    entries: doc.entries.length,
    messages,
    memories: count(doc.memories),
    reports: count(doc.reports),
    exportedAt: typeof doc.exportedAt === 'string' || typeof doc.exportedAt === 'number' ? String(doc.exportedAt) : '',
  };
}

/** "1 entry" / "3 entries" with thousands separators. */
export function pluralize(n, one, many = `${one}s`) {
  const c = Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0;
  return `${c.toLocaleString()} ${c === 1 ? one : many}`;
}

/** Friendly sentence for an import result `{ imported: {entries,...}, skipped }`. */
export function describeImportResult(result) {
  const imported = (result && result.imported) || {};
  const n = (k) => Number(imported[k]) || 0;
  const parts = [];
  if (n('entries')) parts.push(`${n('entries')} ${n('entries') === 1 ? 'entry' : 'entries'}`);
  if (n('messages')) parts.push(`${n('messages')} ${n('messages') === 1 ? 'message' : 'messages'}`);
  if (n('memories')) parts.push(`${n('memories')} ${n('memories') === 1 ? 'memory' : 'memories'}`);
  if (n('reports')) parts.push(`${n('reports')} ${n('reports') === 1 ? 'report' : 'reports'}`);
  const skippedRaw = result && result.skipped;
  const skipped = typeof skippedRaw === 'number' ? skippedRaw : skippedRaw && typeof skippedRaw === 'object' ? Object.values(skippedRaw).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
  const head = parts.length ? `Imported ${parts.join(', ')}.` : 'Nothing new to import.';
  return skipped ? `${head} ${skipped} already in your journal and skipped.` : head;
}

/* ----------------------------------------------------------------- setup */
/** The two next steps shown on the onboarding banner (`setup=1`). */
export function setupSteps(providerId) {
  if (providerId === 'gemini') {
    return ['Create a free key in Google AI Studio and paste it below.', 'Press Test connection, then Save.'];
  }
  if (providerId === 'openai') {
    return ['Pick your service (or paste a base URL), add your API key and choose a model.', 'Press Test connection, then Save.'];
  }
  if (providerId === 'local') {
    return ['Start Ollama (or your server) and download a model with the quick start below.', 'Press Test connection, then Save.'];
  }
  return ['Choose a provider tab and fill it in.', 'Press Test connection, then Save.'];
}

/** Latency like "820 ms" / "1.4 s". */
export function formatLatency(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
}

/* --------------------------------------------------------------- general */
/** Plain-words label for a temperature value (0 to 2). */
export function temperatureWord(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 'Balanced';
  if (v < 0.35) return 'Very focused';
  if (v < 0.65) return 'Focused';
  if (v < 1.0) return 'Balanced';
  if (v < 1.4) return 'Creative';
  return 'Adventurous';
}

/** Persona cards to show: the catalog's personas plus a "custom" card if the catalog did not include one. */
export function personaChoices(personas) {
  const list = (Array.isArray(personas) ? personas : [])
    .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
    .map((p) => ({ id: p.id, name: p.name, description: typeof p.description === 'string' ? p.description : '' }));
  if (!list.some((p) => p.id === 'custom')) {
    list.push({ id: 'custom', name: 'Custom', description: 'Describe the voice and focus you want in your own words.' });
  }
  return list;
}
