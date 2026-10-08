import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  DEFAULT_TIMEOUT_SEC,
  PERSONA_IDS,
  PROVIDER_IDS,
  SETTINGS_LIMITS,
  THINKING_MODES,
  applyEnvSeed,
  defaultSettings,
  isProviderConfigured,
  mergeSettings,
  normalizeSettings,
  publicSettings,
} from '../../src/settings.js';

import { PROVIDER_DEFAULTS } from '../../src/providers/config.js';

const KEY = 'sk-test-SECRETVALUE-1234567890abcd';

test('DEFAULT_SETTINGS has exactly the shape of ARCHITECTURE section 5', () => {
  assert.deepStrictEqual(DEFAULT_SETTINGS, {
    onboarded: false,
    profile: { name: '', about: '' },
    persona: { id: 'companion', custom: '' },
    memory: { enabled: true, autoExtract: true, useRelatedEntries: true },
    ai: {
      enabled: true,
      provider: '',
      temperature: 0.7,
      maxTokens: 700,
      contextBudgetTokens: 3000,
      timeoutSec: 180,
      providers: {
        gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', thinking: 'auto', apiKey: '' },
        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
        local: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b', apiKey: '' },
      },
    },
  });
  assert.deepStrictEqual([...PROVIDER_IDS], ['gemini', 'openai', 'local']);
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS) && Object.isFrozen(DEFAULT_SETTINGS.ai.providers.local));
});

test('the default first-byte timeout is one number, 180 s: enough for a cold local model, inside the validated range', () => {
  assert.equal(DEFAULT_TIMEOUT_SEC, 180);
  assert.equal(DEFAULT_SETTINGS.ai.timeoutSec, 180);
  assert.ok(DEFAULT_SETTINGS.ai.timeoutSec >= SETTINGS_LIMITS.timeoutSec.min && DEFAULT_SETTINGS.ai.timeoutSec <= SETTINGS_LIMITS.timeoutSec.max);
  assert.equal(normalizeSettings({}).ai.timeoutSec, 180);
  assert.equal(normalizeSettings({ ai: { timeoutSec: 'soon' } }).ai.timeoutSec, 180, 'garbage falls back to the default');
  // validation is unchanged: 5..600, clamped; and 120 (the old default) stays a valid choice
  assert.deepStrictEqual({ ...SETTINGS_LIMITS.timeoutSec }, { min: 5, max: 600 });
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { ai: { timeoutSec: 120 } }).settings.ai.timeoutSec, 120);
  // a document saved by an earlier build keeps its explicit number
  assert.equal(normalizeSettings({ ai: { timeoutSec: 120 } }).ai.timeoutSec, 120);
  // the provider layer's own fallbacks agree
  for (const id of PROVIDER_IDS) assert.equal(PROVIDER_DEFAULTS[id].timeoutMs, DEFAULT_SETTINGS.ai.timeoutSec * 1000, id);
});

test('Gemini defaults and thinking modes follow the documented contract (docs/ARCHITECTURE.md section 9)', () => {
  const gemini = DEFAULT_SETTINGS.ai.providers.gemini;
  assert.equal(gemini.model, 'gemini-flash-lite-latest');
  assert.equal(gemini.thinking, 'auto');
  assert.deepStrictEqual([...THINKING_MODES], ['auto', 'low']);
  // The provider layer resolves these same values; the two must never drift apart again.
  for (const id of PROVIDER_IDS) {
    assert.equal(DEFAULT_SETTINGS.ai.providers[id].baseUrl, PROVIDER_DEFAULTS[id].baseUrl, `${id} baseUrl`);
    assert.equal(DEFAULT_SETTINGS.ai.providers[id].model, PROVIDER_DEFAULTS[id].model, `${id} model`);
  }
  assert.equal(gemini.thinking, PROVIDER_DEFAULTS.gemini.thinking);
});

test('Gemini thinking: the values the Settings UI sends are accepted, the retired ones are not', () => {
  for (const value of ['auto', 'low']) {
    const { settings, errors } = mergeSettings(DEFAULT_SETTINGS, { ai: { providers: { gemini: { thinking: value } } } });
    assert.deepStrictEqual(errors, {}, value);
    assert.equal(settings.ai.providers.gemini.thinking, value);
  }
  for (const value of ['fast', 'default', 'minimal', '', null]) {
    const { errors } = mergeSettings(DEFAULT_SETTINGS, { ai: { providers: { gemini: { thinking: value } } } });
    assert.match(errors['ai.providers.gemini.thinking'], /auto, low/, String(value));
  }
  // A document saved by an earlier build still loads: unknown values fall back to 'auto'.
  for (const legacy of ['fast', 'default']) {
    const stored = { ai: { providers: { gemini: { thinking: legacy } } } };
    assert.equal(normalizeSettings(stored).ai.providers.gemini.thinking, 'auto', legacy);
  }
});

test('defaultSettings() returns an independent mutable copy', () => {
  const a = defaultSettings();
  a.ai.providers.local.model = 'changed';
  assert.equal(DEFAULT_SETTINGS.ai.providers.local.model, 'llama3.2:3b');
  assert.equal(defaultSettings().ai.providers.local.model, 'llama3.2:3b');
});

test('normalizeSettings fills defaults for missing, invalid and hostile input', () => {
  for (const input of [undefined, null, 'x', 42, [], {}, { ai: 'nope' }, { ai: { providers: [] } }]) {
    assert.deepStrictEqual(normalizeSettings(input), DEFAULT_SETTINGS, JSON.stringify(input));
  }
  const out = normalizeSettings({ onboarded: true, ai: { provider: 'local' } });
  assert.equal(out.onboarded, true);
  assert.equal(out.ai.provider, 'local');
  assert.equal(out.ai.temperature, 0.7);
});

test('normalizeSettings never returns shared references and drops unknown keys', () => {
  const polluted = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":1,"evil":1,"ai":{"__proto__":{"p":1},"extra":1,"providers":{"hack":{"apiKey":"zzz"},"openai":{"apiKey":"k","other":1}}}}',
  );
  const out = normalizeSettings(polluted);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(out, 'evil'), false);
  assert.equal(Object.hasOwn(out.ai, 'extra'), false);
  assert.equal(Object.hasOwn(out.ai.providers, 'hack'), false);
  assert.equal(Object.hasOwn(out.ai.providers.openai, 'other'), false);
  assert.equal(out.ai.providers.openai.apiKey, 'k');
  out.ai.providers.local.model = 'mutated';
  assert.equal(DEFAULT_SETTINGS.ai.providers.local.model, 'llama3.2:3b');
});

test('normalizeSettings clamps numbers, trims strings, enforces enums and limits', () => {
  const out = normalizeSettings({
    profile: { name: `  ${'N'.repeat(200)}  `, about: 'a'.repeat(5000) },
    persona: { id: 'wizard', custom: 'c'.repeat(5000) },
    ai: {
      provider: 'skynet',
      temperature: 99,
      maxTokens: 1,
      contextBudgetTokens: 1e9,
      timeoutSec: 0,
      providers: {
        gemini: { thinking: 'extreme', model: 'm'.repeat(500) },
        openai: { apiKey: `  ${'k'.repeat(900)}\n` },
      },
    },
  });
  assert.equal(out.profile.name, 'N'.repeat(80));
  assert.equal(out.profile.about.length, 1000);
  assert.equal(out.persona.id, 'companion');
  assert.equal(out.persona.custom.length, 1500);
  assert.equal(out.ai.provider, '');
  assert.equal(out.ai.temperature, 2.0);
  assert.equal(out.ai.maxTokens, 64);
  assert.equal(out.ai.contextBudgetTokens, 32000);
  assert.equal(out.ai.timeoutSec, 5);
  assert.equal(out.ai.providers.gemini.thinking, 'auto');
  assert.equal(out.ai.providers.gemini.model.length, 200);
  assert.equal(out.ai.providers.openai.apiKey, 'k'.repeat(512));
});

test('numbers are rounded sensibly', () => {
  const { settings, errors } = mergeSettings(DEFAULT_SETTINGS, { ai: { temperature: 0.12345, maxTokens: 700.6 } });
  assert.deepStrictEqual(errors, {});
  assert.equal(settings.ai.temperature, 0.12);
  assert.equal(settings.ai.maxTokens, 701);
});

test('api keys: control characters and whitespace are stripped', () => {
  const { settings, errors } = mergeSettings(DEFAULT_SETTINGS, { ai: { providers: { openai: { apiKey: ' sk-ab\tcd\u0000ef\r\n ' } } } });
  assert.deepStrictEqual(errors, {});
  assert.equal(settings.ai.providers.openai.apiKey, 'sk-abcdef');
});

test('mergeSettings: round trip of a full document is a no-op', () => {
  const doc = normalizeSettings({
    onboarded: true,
    profile: { name: 'Sam', about: 'I like long walks.\nAnd tea.' },
    persona: { id: 'custom', custom: 'Be brief.' },
    memory: { enabled: false, autoExtract: false, useRelatedEntries: true },
    ai: {
      enabled: true,
      provider: 'openai',
      temperature: 1.25,
      maxTokens: 900,
      contextBudgetTokens: 4000,
      timeoutSec: 60,
      providers: {
        gemini: { baseUrl: 'https://example.com', model: 'gemini-x', thinking: 'low', apiKey: 'g-key-1234' },
        openai: { baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: KEY },
        local: { baseUrl: 'http://localhost:8080/v1', model: 'qwen2.5:1.5b', apiKey: '' },
      },
    },
  });
  const again = mergeSettings(doc, doc);
  assert.deepStrictEqual(again.errors, {});
  assert.deepStrictEqual(again.settings, doc);
  assert.deepStrictEqual(normalizeSettings(JSON.parse(JSON.stringify(doc))), doc);
});

test('mergeSettings: public settings can be sent back and keep the saved key', () => {
  const stored = mergeSettings(DEFAULT_SETTINGS, { ai: { providers: { openai: { apiKey: KEY } } } }).settings;
  const pub = publicSettings(stored, {});
  const { settings, errors } = mergeSettings(stored, JSON.parse(JSON.stringify(pub)));
  assert.deepStrictEqual(errors, {});
  assert.equal(settings.ai.providers.openai.apiKey, KEY);
  assert.deepStrictEqual(settings, stored);
});

test('mergeSettings: apiKey string sets, null clears, undefined/omitted keeps', () => {
  let s = mergeSettings(DEFAULT_SETTINGS, { ai: { providers: { openai: { apiKey: KEY } } } }).settings;
  assert.equal(s.ai.providers.openai.apiKey, KEY);
  s = mergeSettings(s, { ai: { providers: { openai: { model: 'gpt-4.1-mini' } } } }).settings;
  assert.equal(s.ai.providers.openai.apiKey, KEY, 'omitted keeps');
  s = mergeSettings(s, { ai: { providers: { openai: { apiKey: undefined } } } }).settings;
  assert.equal(s.ai.providers.openai.apiKey, KEY, 'undefined keeps');
  s = mergeSettings(s, { ai: { providers: { openai: { apiKey: null } } } }).settings;
  assert.equal(s.ai.providers.openai.apiKey, '', 'null clears');
  s = mergeSettings(s, { ai: { providers: { gemini: { apiKey: '' } } } }).settings;
  assert.equal(s.ai.providers.gemini.apiKey, '', 'empty string sets an empty key');
});

test('mergeSettings: apiKeySet / apiKeyHint / apiKeySource in a patch are ignored', () => {
  const { settings, errors } = mergeSettings(DEFAULT_SETTINGS, {
    ai: { providers: { openai: { apiKeySet: true, apiKeyHint: '…hack', apiKeySource: 'env', model: 'x' } } },
  });
  assert.deepStrictEqual(errors, {});
  assert.deepStrictEqual(Object.keys(settings.ai.providers.openai).sort(), ['apiKey', 'baseUrl', 'model']);
  assert.equal(settings.ai.providers.openai.model, 'x');
});

test('mergeSettings: deep merge keeps untouched siblings', () => {
  const base = normalizeSettings({ profile: { name: 'Sam', about: 'hello' }, ai: { temperature: 1.5 } });
  const { settings } = mergeSettings(base, { profile: { about: 'new' } });
  assert.equal(settings.profile.name, 'Sam');
  assert.equal(settings.profile.about, 'new');
  assert.equal(settings.ai.temperature, 1.5);
});

test('mergeSettings: unknown keys are dropped without error', () => {
  const patch = JSON.parse('{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}},"nonsense":1,"ai":{"hack":1,"providers":{"evil":{"apiKey":"x"}}}}');
  const { settings, errors } = mergeSettings(DEFAULT_SETTINGS, patch);
  assert.deepStrictEqual(errors, {});
  assert.deepStrictEqual(settings, DEFAULT_SETTINGS);
  assert.equal({}.admin, undefined);
});

test('mergeSettings: every validation error path returns a field map and changes nothing', () => {
  const cases = [
    [{ onboarded: 'yes' }, 'onboarded'],
    [{ profile: { name: 5 } }, 'profile.name'],
    [{ profile: { name: 'x'.repeat(81) } }, 'profile.name'],
    [{ profile: { about: 'x'.repeat(1001) } }, 'profile.about'],
    [{ profile: 'text' }, 'profile'],
    [{ persona: { id: 'wizard' } }, 'persona.id'],
    [{ persona: { id: null } }, 'persona.id'],
    [{ persona: { custom: 'x'.repeat(1501) } }, 'persona.custom'],
    [{ memory: { enabled: 1 } }, 'memory.enabled'],
    [{ memory: { autoExtract: 'true' } }, 'memory.autoExtract'],
    [{ memory: { useRelatedEntries: null } }, 'memory.useRelatedEntries'],
    [{ ai: { enabled: 'on' } }, 'ai.enabled'],
    [{ ai: { provider: 'skynet' } }, 'ai.provider'],
    [{ ai: { provider: 7 } }, 'ai.provider'],
    [{ ai: { temperature: 'hot' } }, 'ai.temperature'],
    [{ ai: { temperature: NaN } }, 'ai.temperature'],
    [{ ai: { maxTokens: '700' } }, 'ai.maxTokens'],
    [{ ai: { contextBudgetTokens: Infinity } }, 'ai.contextBudgetTokens'],
    [{ ai: { timeoutSec: {} } }, 'ai.timeoutSec'],
    [{ ai: { providers: { gemini: { thinking: 'max' } } } }, 'ai.providers.gemini.thinking'],
    [{ ai: { providers: { openai: { baseUrl: 'ftp://example.com' } } } }, 'ai.providers.openai.baseUrl'],
    [{ ai: { providers: { openai: { baseUrl: 'javascript:alert(1)' } } } }, 'ai.providers.openai.baseUrl'],
    [{ ai: { providers: { openai: { baseUrl: 'not a url' } } } }, 'ai.providers.openai.baseUrl'],
    [{ ai: { providers: { openai: { baseUrl: 'http://user:pw@host/v1' } } } }, 'ai.providers.openai.baseUrl'],
    [{ ai: { providers: { openai: { baseUrl: 'https://host/v1?key=secret' } } } }, 'ai.providers.openai.baseUrl'],
    [{ ai: { providers: { openai: { baseUrl: 'http://ho\nst/v1' } } } }, 'ai.providers.openai.baseUrl'],
    [{ ai: { providers: { openai: { baseUrl: 42 } } } }, 'ai.providers.openai.baseUrl'],
    [{ ai: { providers: { local: { model: 'm'.repeat(201) } } } }, 'ai.providers.local.model'],
    [{ ai: { providers: { local: { model: false } } } }, 'ai.providers.local.model'],
    [{ ai: { providers: { local: { apiKey: 'k'.repeat(513) } } } }, 'ai.providers.local.apiKey'],
    [{ ai: { providers: { local: { apiKey: 12345 } } } }, 'ai.providers.local.apiKey'],
    [{ ai: { providers: { local: { apiKey: 'schlüssel' } } } }, 'ai.providers.local.apiKey'],
    [{ ai: { providers: 5 } }, 'ai.providers'],
    [{ ai: { providers: { gemini: 'x' } } }, 'ai.providers.gemini'],
  ];
  const base = normalizeSettings({ profile: { name: 'Keep' } });
  for (const [patch, path] of cases) {
    const { settings, errors } = mergeSettings(base, patch);
    assert.ok(path in errors, `${path} should be reported for ${JSON.stringify(patch)}; got ${JSON.stringify(errors)}`);
    assert.equal(typeof errors[path], 'string');
    assert.ok(errors[path].length > 3);
    assert.deepStrictEqual(settings, base, 'invalid patch must not change anything');
  }
  for (const bad of [null, 'x', 5, [], true]) {
    const { settings, errors } = mergeSettings(base, bad);
    assert.ok('settings' in errors, JSON.stringify(bad));
    assert.deepStrictEqual(settings, base);
  }
});

test('mergeSettings reports several errors at once', () => {
  const { errors } = mergeSettings(DEFAULT_SETTINGS, { ai: { temperature: 'x', provider: 'nope' }, onboarded: 3 });
  assert.deepStrictEqual(Object.keys(errors).sort(), ['ai.provider', 'ai.temperature', 'onboarded']);
});

test('mergeSettings: out-of-range numbers are clamped, not errors', () => {
  const { settings, errors } = mergeSettings(DEFAULT_SETTINGS, { ai: { temperature: -5, maxTokens: 99999, contextBudgetTokens: 1, timeoutSec: 99999 } });
  assert.deepStrictEqual(errors, {});
  assert.equal(settings.ai.temperature, 0);
  assert.equal(settings.ai.maxTokens, 8192);
  assert.equal(settings.ai.contextBudgetTokens, 500);
  assert.equal(settings.ai.timeoutSec, 600);
});

test('mergeSettings: URLs are trimmed, trailing slashes removed, empty resets to default', () => {
  let { settings } = mergeSettings(DEFAULT_SETTINGS, { ai: { providers: { local: { baseUrl: '  http://localhost:8080/v1///  ', model: '  qwen2.5:1.5b  ' } } } });
  assert.equal(settings.ai.providers.local.baseUrl, 'http://localhost:8080/v1');
  assert.equal(settings.ai.providers.local.model, 'qwen2.5:1.5b');
  ({ settings } = mergeSettings(settings, { ai: { providers: { local: { baseUrl: '', model: '   ' } } } }));
  assert.equal(settings.ai.providers.local.baseUrl, DEFAULT_SETTINGS.ai.providers.local.baseUrl);
  assert.equal(settings.ai.providers.local.model, DEFAULT_SETTINGS.ai.providers.local.model);
  ({ settings } = mergeSettings(settings, { ai: { providers: { openai: { baseUrl: 'HTTP://LAN-BOX:1234' } } } }));
  assert.equal(settings.ai.providers.openai.baseUrl, 'HTTP://LAN-BOX:1234');
});

test('mergeSettings: IPv6, mixed-case scheme, ports and paths are accepted as typed', () => {
  const { settings, errors } = mergeSettings(DEFAULT_SETTINGS, {
    ai: { providers: { local: { baseUrl: 'http://[::1]:11434/v1' }, openai: { baseUrl: 'HTTPS://Api.Example.com:8443/v1/openai/' }, gemini: { baseUrl: 'http://192.168.1.20:3000' } } },
  });
  assert.deepStrictEqual(errors, {});
  assert.equal(settings.ai.providers.local.baseUrl, 'http://[::1]:11434/v1');
  assert.equal(settings.ai.providers.openai.baseUrl, 'HTTPS://Api.Example.com:8443/v1/openai');
  assert.equal(settings.ai.providers.gemini.baseUrl, 'http://192.168.1.20:3000');
  for (const bad of ['//host/v1', 'localhost:11434/v1', 'http://', 'https:///v1', 'file:///etc/passwd', 'data:text/plain,hi', 'ws://host']) {
    const result = mergeSettings(DEFAULT_SETTINGS, { ai: { providers: { local: { baseUrl: bad } } } });
    assert.ok('ai.providers.local.baseUrl' in result.errors, bad);
  }
});

test('mergeSettings: text fields strip control characters; names are single line; unicode survives', () => {
  const { settings } = mergeSettings(DEFAULT_SETTINGS, {
    profile: { name: ' Zoë\n 😀\u0000 ', about: 'line one\r\nline two\u0007\n日本語' },
    persona: { id: 'custom', custom: '  Be kind.  ' },
  });
  assert.equal(settings.profile.name, 'Zoë 😀');
  assert.equal(settings.profile.about, 'line one\nline two\n日本語');
  assert.equal(settings.persona.custom, 'Be kind.');
  assert.ok(PERSONA_IDS.includes(settings.persona.id));
});

test('mergeSettings does not mutate its inputs', () => {
  const current = normalizeSettings({ profile: { name: 'A' } });
  const snapshot = JSON.stringify(current);
  const patch = { profile: { name: 'B' }, ai: { providers: { openai: { apiKey: KEY } } } };
  const patchSnapshot = JSON.stringify(patch);
  const { settings } = mergeSettings(current, patch);
  assert.equal(JSON.stringify(current), snapshot);
  assert.equal(JSON.stringify(patch), patchSnapshot);
  settings.profile.name = 'C';
  assert.equal(current.profile.name, 'A');
});

test('publicSettings: no raw key anywhere, flags and hint per provider', () => {
  const env = { OPENAI_API_KEY: 'env-OPENAI-key-9999' };
  const stored = mergeSettings(DEFAULT_SETTINGS, {
    ai: { providers: { gemini: { apiKey: KEY }, local: { apiKey: 'short' } } },
  }).settings;
  const pub = publicSettings(stored, env);
  const text = JSON.stringify(pub);
  assert.ok(!text.includes(KEY), 'saved key leaked');
  assert.ok(!text.includes('SECRETVALUE'), 'saved key fragment leaked');
  assert.ok(!text.includes('env-OPENAI-key-9999'), 'env key leaked');
  assert.ok(!text.includes('"apiKey"'), 'apiKey property must be gone');
  assert.ok(!text.includes('short'), 'short key leaked');

  const g = pub.ai.providers.gemini;
  assert.deepStrictEqual([g.apiKeySet, g.apiKeyHint, g.apiKeySource], [true, '…abcd', 'settings']);
  const o = pub.ai.providers.openai;
  assert.deepStrictEqual([o.apiKeySet, o.apiKeyHint, o.apiKeySource], [true, '…9999', 'env']);
  const l = pub.ai.providers.local;
  assert.deepStrictEqual([l.apiKeySet, l.apiKeyHint, l.apiKeySource], [true, '…', 'settings'], 'short keys show no characters');
  // everything else is identical to the internal shape
  const stripped = structuredClone(pub);
  for (const id of PROVIDER_IDS) {
    for (const k of ['apiKeySet', 'apiKeyHint', 'apiKeySource']) delete stripped.ai.providers[id][k];
    stripped.ai.providers[id].apiKey = stored.ai.providers[id].apiKey;
  }
  assert.deepStrictEqual(stripped, stored);
});

test('publicSettings: nothing set -> none; does not mutate input', () => {
  const stored = defaultSettings();
  const pub = publicSettings(stored, {});
  for (const id of PROVIDER_IDS) {
    assert.deepStrictEqual(
      [pub.ai.providers[id].apiKeySet, pub.ai.providers[id].apiKeyHint, pub.ai.providers[id].apiKeySource],
      [false, '', 'none'],
    );
  }
  assert.deepStrictEqual(stored, DEFAULT_SETTINGS);
  assert.ok(Object.hasOwn(stored.ai.providers.openai, 'apiKey'));
});

test('env fallback and precedence: saved key wins, env fills the gap, GOOGLE_API_KEY works', () => {
  const stored = mergeSettings(DEFAULT_SETTINGS, { ai: { providers: { openai: { apiKey: KEY } } } }).settings;
  const env = { OPENAI_API_KEY: 'env-key-should-lose-1111', GEMINI_API_KEY: '', GOOGLE_API_KEY: 'google-key-2222', LOCAL_LLM_API_KEY: 'local-key-3333' };
  const pub = publicSettings(stored, env);
  assert.equal(pub.ai.providers.openai.apiKeySource, 'settings');
  assert.equal(pub.ai.providers.openai.apiKeyHint, '…abcd');
  assert.equal(pub.ai.providers.gemini.apiKeySource, 'env');
  assert.equal(pub.ai.providers.gemini.apiKeyHint, '…2222');
  assert.equal(pub.ai.providers.local.apiKeySource, 'env');
  // clearing the saved key lets the environment apply again
  const cleared = mergeSettings(stored, { ai: { providers: { openai: { apiKey: null } } } }).settings;
  const pub2 = publicSettings(cleared, env);
  assert.equal(pub2.ai.providers.openai.apiKeySource, 'env');
  assert.equal(pub2.ai.providers.openai.apiKeyHint, '…1111');
});

test('isProviderConfigured', () => {
  const none = {};
  assert.equal(isProviderConfigured(DEFAULT_SETTINGS, none), false, 'no provider selected');
  const withProvider = (provider, keys = {}) =>
    mergeSettings(DEFAULT_SETTINGS, { ai: { provider, providers: Object.fromEntries(Object.entries(keys).map(([id, apiKey]) => [id, { apiKey }])) } }).settings;

  assert.equal(isProviderConfigured(withProvider('gemini'), none), false, 'gemini needs a key');
  assert.equal(isProviderConfigured(withProvider('gemini', { gemini: 'AIza-key' }), none), true);
  assert.equal(isProviderConfigured(withProvider('gemini'), { GEMINI_API_KEY: 'from-env' }), true);
  assert.equal(isProviderConfigured(withProvider('gemini'), { GOOGLE_API_KEY: 'from-env' }), true);
  assert.equal(isProviderConfigured(withProvider('openai'), { GEMINI_API_KEY: 'wrong-provider' }), false);
  assert.equal(isProviderConfigured(withProvider('openai', { openai: 'sk-1' }), none), true);
  assert.equal(isProviderConfigured(withProvider('local'), none), true, 'local needs no key');
  assert.equal(isProviderConfigured({ ...withProvider('local'), ai: { provider: 'nope' } }, none), false);
  // explicit provider id (third argument, or second when no env is given)
  assert.equal(isProviderConfigured(withProvider('local'), none, 'openai'), false);
  assert.equal(isProviderConfigured(withProvider('local'), none, 'local'), true);
  assert.equal(isProviderConfigured(withProvider('', {}), none, 'local'), true);
  assert.equal(isProviderConfigured(withProvider('openai'), 'local'), true);
  assert.equal(isProviderConfigured(null, none), false);
  assert.equal(isProviderConfigured(DEFAULT_SETTINGS, none, 'constructor'), false);
});

test('applyEnvSeed puts the environment\'s URL and model into the settings it is given (the caller decides that this is a fresh install)', () => {
  const env = { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1/', LOCAL_LLM_BASE_URL: 'http://localhost:8080/v1', LOCAL_LLM_MODEL: 'qwen2.5:1.5b' };
  const seeded = applyEnvSeed(DEFAULT_SETTINGS, env);
  assert.equal(seeded.ai.providers.openai.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(seeded.ai.providers.local.baseUrl, 'http://localhost:8080/v1');
  assert.equal(seeded.ai.providers.local.model, 'qwen2.5:1.5b');
  assert.equal(seeded.ai.providers.gemini.baseUrl, DEFAULT_SETTINGS.ai.providers.gemini.baseUrl);
  assert.deepStrictEqual(DEFAULT_SETTINGS.ai.providers.local, { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b', apiKey: '' }, 'input untouched');

  // idempotent
  assert.deepStrictEqual(applyEnvSeed(seeded, env), seeded);
  // everything that is not a seeded field stays as given
  const custom = mergeSettings(DEFAULT_SETTINGS, { profile: { name: 'Sam' }, ai: { temperature: 1.2, providers: { local: { apiKey: 'lk-1234567890' } } } }).settings;
  const withEnv = applyEnvSeed(custom, env);
  assert.equal(withEnv.profile.name, 'Sam');
  assert.equal(withEnv.ai.temperature, 1.2);
  assert.equal(withEnv.ai.providers.local.apiKey, 'lk-1234567890');
});

test('applyEnvSeed has no "equals the built-in default" heuristic any more: it seeds what it is given, WHEN is the caller\'s decision', () => {
  // The old heuristic treated "still equals the default" as "never chosen" and replaced it on EVERY read, so a person could
  // not pick http://localhost:11434/v1 on purpose while LOCAL_LLM_BASE_URL was set. Seeding now happens only while no
  // settings document exists (loadEffectiveSettings, see test/server/env-seed.test.js for the whole flow).
  const env = { LOCAL_LLM_BASE_URL: 'http://ollama:11434/v1', LOCAL_LLM_MODEL: 'qwen2.5:1.5b' };
  const chosen = mergeSettings(DEFAULT_SETTINGS, { ai: { providers: { local: { baseUrl: 'http://lan:1234/v1', model: 'phi3' } } } }).settings;
  const seeded = applyEnvSeed(chosen, env);
  assert.equal(seeded.ai.providers.local.baseUrl, 'http://ollama:11434/v1');
  assert.equal(seeded.ai.providers.local.model, 'qwen2.5:1.5b');
  assert.equal(chosen.ai.providers.local.baseUrl, 'http://lan:1234/v1', 'the input is not modified');
  // validation accepts the built-in default as a deliberate choice
  const explicitDefault = mergeSettings(seeded, { ai: { providers: { local: { baseUrl: 'http://localhost:11434/v1' } } } });
  assert.deepStrictEqual(explicitDefault.errors, {});
  assert.equal(explicitDefault.settings.ai.providers.local.baseUrl, 'http://localhost:11434/v1');
});

test('applyEnvSeed ignores empty and invalid environment values', () => {
  const env = { OPENAI_BASE_URL: 'javascript:alert(1)', LOCAL_LLM_BASE_URL: '   ', LOCAL_LLM_MODEL: 'm'.repeat(300) };
  assert.deepStrictEqual(applyEnvSeed(DEFAULT_SETTINGS, env), DEFAULT_SETTINGS);
  assert.deepStrictEqual(applyEnvSeed(DEFAULT_SETTINGS, {}), DEFAULT_SETTINGS);
  assert.deepStrictEqual(applyEnvSeed(DEFAULT_SETTINGS, { OPENAI_BASE_URL: 'http://u:p@host/' }), DEFAULT_SETTINGS);
});

test('hostile settings JSON cannot smuggle a key into the public shape', () => {
  const hostile = JSON.parse(
    `{"ai":{"providers":{"openai":{"apiKey":"${KEY}","apiKeySet":false,"apiKeyHint":"${KEY}","apiKeySource":"${KEY}","baseUrl":"https://api.openai.com/v1"}}}}`,
  );
  const pub = publicSettings(hostile, {});
  assert.ok(!JSON.stringify(pub).includes('SECRETVALUE'));
  assert.equal(pub.ai.providers.openai.apiKeySet, true);
  assert.equal(pub.ai.providers.openai.apiKeyHint, '…abcd');
});
