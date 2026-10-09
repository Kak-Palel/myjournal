// Pure-logic tests for the polish round: model size from a model name, the small-model memory warning, the "key found in the
// environment" wording with the variable the server really found, the local Test connection wait text, the model picker's
// copy and the Data-tab privacy sentence. No DOM.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SMALL_MODEL_LIMIT_B, isSmallModel, modelSizeB } from '../../public/js/lib/model-size.js';
import {
  AUTO_EXTRACT_LABEL, SMALL_MODEL_MEMORY_WARNING, showsSmallModelWarning,
} from '../../public/js/components/small-model-note.js';
import {
  LIMITS, describeSmallModel, envKeyBadgeText, envKeyName, envKeysFound, keyStatus, setupSteps, testingMessage,
} from '../../public/js/components/settings-logic.js';
import { DATA_SENT_WITH_A_REPLY, DATA_SENT_WITH_AI_STEPS } from '../../public/js/components/privacy-copy.js';
import { SETTINGS_LIMITS as SERVER_LIMITS } from '../../src/settings.js';
import { describeProviders } from '../../src/providers/index.js';

/* ======================================================================== modelSizeB */
describe('modelSizeB: the size in billions of parameters, read from the model name', () => {
  const table = [
    // the models this app suggests or was measured with
    ['llama3.2:1b', 1], ['qwen3:1.7b', 1.7], ['smollm2:360m', 0.36], ['gemma2:2b', 2], ['qwen2.5:1.5b', 1.5], ['llama3.2:3b', 3],
    ['smollm2:1.7b', 1.7], ['mistral-7b-instruct', 7],
    // upper case, "M" for millions, fractions
    ['Llama-3.2-3B-Instruct', 3], ['gemma3:270m', 0.27], ['smollm2:135m', 0.135], ['phi3:3.8b', 3.8], ['tinyllama:1.1b', 1.1],
    // registry paths, tags and quantisation suffixes
    ['hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M', 3],
    ['registry.ollama.ai/library/llama3.2:1b-instruct-q8_0', 1],
    ['smollm2:1.7b-instruct-q4_K_M', 1.7],
    ['llama3.1:70b-instruct-q4_0', 70],
    // llama.cpp reports the file path
    ['/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', 0.5],
    ['C:\\models\\phi-3.8b.gguf', 3.8],
    ['Llama-3.2-1B-Instruct-bf16', 1],
    // the family's own digits are not a size
    ['gemma-2-2b-it', 2], ['deepseek-r1:7b', 7], ['qwen3-raw:1.7b', 1.7],
    // total size, not the active experts
    ['qwen3:30b-a3b', 30], ['mixtral:8x7b', 56],
  ];
  for (const [name, size] of table) test(`${name} -> ${size}`, () => assert.equal(modelSizeB(name), size));

  test('a name that does not state its size is unknown (null), never a guess', () => {
    for (const name of ['gpt-4o-mini', 'llama3.2', 'llama3.2:latest', 'phi3:mini', 'gemini-flash-lite-latest', 'ggml-model-q4_0.gguf',
      'my-model-Q5_K_M', 'gemma2b', '4bit', 'qwen2.5', 'llama3.2:0b', 'command-r7b']) {
      assert.equal(modelSizeB(name), null, name);
    }
  });

  test('a user or host name in a registry path is not read as a size', () => {
    assert.equal(modelSizeB('hf.co/team-7b/some-model:latest'), null);
    assert.equal(modelSizeB('hf.co/team-7b/some-model-2b:latest'), 2);
  });

  test('anything that is not a string is null', () => {
    for (const v of [undefined, null, 42, {}, [], '', '   ', true]) assert.equal(modelSizeB(v), null, String(v));
  });

  test('no floating point dust: 0.36 is 0.36', () => {
    assert.equal(String(modelSizeB('smollm2:360m')), '0.36');
    assert.equal(String(modelSizeB('gemma3:270m')), '0.27');
  });

  test('isSmallModel: strictly under 3B; an unknown size is not small', () => {
    assert.equal(SMALL_MODEL_LIMIT_B, 3);
    for (const name of ['llama3.2:1b', 'qwen3:1.7b', 'smollm2:360m', 'gemma2:2b', 'qwen2.5:1.5b', 'llama3.2:2.9b']) assert.equal(isSmallModel(name), true, name);
    for (const name of ['llama3.2:3b', 'phi3:3.8b', 'mistral-7b-instruct', 'llama3.1:70b', 'llama3.2', 'gpt-4o-mini', '', null]) assert.equal(isSmallModel(name), false, String(name));
  });
});

/* ============================================================ the small-model memory warning */
describe('small-model memory warning', () => {
  const settings = (model, { provider = 'local', enabled = true, memory } = {}) => ({ ai: { enabled, provider, providers: { local: { model } } }, ...(memory ? { memory } : {}) });

  test('the sentence, and the switch it names is the one on the Memory page', () => {
    assert.equal(SMALL_MODEL_MEMORY_WARNING, `Small models (under about 3B) often write poor memory notes. Check the list now and then, or switch off "${AUTO_EXTRACT_LABEL}".`);
    assert.equal(AUTO_EXTRACT_LABEL, 'Suggest memories when I wrap up an entry');
    const memoryView = readFileSync(new URL('../../public/js/views/memory.js', import.meta.url), 'utf8');
    assert.match(memoryView, /makeSwitch\('autoExtract', AUTO_EXTRACT_LABEL,/, 'the switch is built from the same constant');
  });

  test('shown only for the active local provider with a model under about 3B', () => {
    assert.equal(showsSmallModelWarning(settings('llama3.2:1b')), true);
    assert.equal(showsSmallModelWarning(settings('qwen3:1.7b')), true);
    assert.equal(showsSmallModelWarning(settings('smollm2:360m')), true);
    assert.equal(showsSmallModelWarning(settings('llama3.2:3b')), false, '3B is not under 3B');
    assert.equal(showsSmallModelWarning(settings('mistral-7b-instruct')), false);
    assert.equal(showsSmallModelWarning(settings('llama3.2')), false, 'no size in the name: no warning on a guess');
    assert.equal(showsSmallModelWarning(settings('llama3.2:1b', { provider: 'gemini' })), false, 'the active provider is not the local one');
    assert.equal(showsSmallModelWarning(settings('llama3.2:1b', { provider: 'openai' })), false);
    assert.equal(showsSmallModelWarning(settings('llama3.2:1b', { provider: '' })), false);
    assert.equal(showsSmallModelWarning(settings('llama3.2:1b', { enabled: false })), false, 'the AI is switched off');
  });

  test('is gone once the person has followed its advice: Suggest memories off, or memory off altogether', () => {
    const on = { enabled: true, autoExtract: true, useRelatedEntries: true };
    assert.equal(showsSmallModelWarning(settings('llama3.2:1b', { memory: on })), true);
    assert.equal(showsSmallModelWarning(settings('llama3.2:1b', { memory: { ...on, autoExtract: false } })), false, 'the switch the sentence names is already off');
    assert.equal(showsSmallModelWarning(settings('llama3.2:1b', { memory: { ...on, enabled: false } })), false, 'memory is off, nothing is suggested');
    assert.equal(showsSmallModelWarning(settings('llama3.2:1b', { memory: { ...on, useRelatedEntries: false } })), true, 'recall has nothing to do with it');
  });

  test('tolerates settings that are missing or odd', () => {
    for (const bad of [undefined, null, {}, { ai: null }, { ai: { provider: 'local' } }, { ai: { provider: 'local', providers: {} } }, { ai: { provider: 'local', providers: { local: { model: 7 } } } }]) {
      assert.equal(showsSmallModelWarning(bad), false, JSON.stringify(bad));
    }
  });

  test('is a warning: it exports no way to block anything', () => {
    // the module only decides whether to say something; the Memory switch and the Local tab are untouched by it
    const src = readFileSync(new URL('../../public/js/components/small-model-note.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /saveSettings|disabled|autoExtract\s*:/);
  });
});

/* ==================================================== the variable the server found for a key */
describe('keyEnvName: the welcome badge and "Using ... from the environment" name the variable that is really set', () => {
  test('envKeysFound uses the row\'s keyEnvName, else the provider\'s usual variable', () => {
    assert.deepEqual(envKeysFound([{ id: 'gemini', needsKey: true, keySource: 'env', keyEnvName: 'GOOGLE_API_KEY' }]), { gemini: 'GOOGLE_API_KEY' });
    assert.deepEqual(envKeysFound([{ id: 'gemini', needsKey: true, keySource: 'env', keyEnvName: 'GEMINI_API_KEY' }]), { gemini: 'GEMINI_API_KEY' });
    assert.deepEqual(envKeysFound([{ id: 'gemini', needsKey: true, keySource: 'env' }]), { gemini: 'GEMINI_API_KEY' }, 'an older server sends no name');
    assert.deepEqual(envKeysFound([{ id: 'gemini', needsKey: true, keySource: 'env', keyEnvName: '' }]), { gemini: 'GEMINI_API_KEY' });
    assert.deepEqual(envKeysFound([{ id: 'gemini', needsKey: true, keySource: 'settings', keyEnvName: '' }]), {}, 'a saved key is not "found in the environment"');
  });

  test('only something that looks like a variable name is ever shown', () => {
    assert.equal(envKeyName('gemini', 'GOOGLE_API_KEY'), 'GOOGLE_API_KEY');
    for (const odd of ['', 'two words', 'x=1', '<b>', 'a'.repeat(65), 42, null, undefined, {}]) assert.equal(envKeyName('gemini', odd), 'GEMINI_API_KEY', String(odd));
    assert.equal(envKeyName('openai'), 'OPENAI_API_KEY');
    assert.equal(envKeyName('nope'), 'an environment variable');
  });

  test('badge text, key status line and setup step', () => {
    assert.equal(envKeyBadgeText('gemini', 'GOOGLE_API_KEY'), 'Found GOOGLE_API_KEY in your environment');
    assert.equal(envKeyBadgeText('gemini'), 'Found GEMINI_API_KEY in your environment');
    const saved = { apiKeySet: true, apiKeySource: 'env', apiKeyHint: '…abcd' };
    assert.equal(keyStatus(saved, 'gemini', 'GOOGLE_API_KEY').text, 'Using GOOGLE_API_KEY from the environment');
    assert.match(keyStatus(saved, 'gemini', 'GOOGLE_API_KEY').placeholder, /GOOGLE_API_KEY/);
    assert.equal(keyStatus(saved, 'gemini').text, 'Using GEMINI_API_KEY from the environment');
    assert.equal(keyStatus(saved, 'gemini', '').text, 'Using GEMINI_API_KEY from the environment');
    assert.equal(keyStatus({ ...saved, apiKeySource: 'settings' }, 'gemini', 'GOOGLE_API_KEY').kind, 'saved', 'a saved key never names the environment');
    assert.match(setupSteps('gemini', { keyFromEnv: true, envName: 'GOOGLE_API_KEY' })[0], /GOOGLE_API_KEY.*Test connection/);
    assert.match(setupSteps('gemini', { keyFromEnv: true })[0], /GEMINI_API_KEY/);
  });

  test('works on the rows the server really sends', () => {
    const value = 'AIza-this-value-must-never-appear-1234';
    const rows = describeProviders({ GOOGLE_API_KEY: value }).map((r) => ({ ...r, configured: true }));
    const found = envKeysFound(rows);
    assert.deepEqual(found, { gemini: 'GOOGLE_API_KEY' });
    assert.ok(!JSON.stringify(found).includes(value));
  });
});

/* ================================================== Test connection waits for a cold local model */
describe('Test connection wait text', () => {
  test('a local model gets the long explanation, the others the short text', () => {
    assert.equal(testingMessage('local'), 'Contacting the model... The first request after a model starts loads it into memory, which can take a minute. Please wait.');
    assert.equal(testingMessage('gemini'), 'Contacting the model...');
    assert.equal(testingMessage('openai'), 'Contacting the model...');
  });
});

/* ===================================================== the timeout limit and the model picker copy */
describe('settings copy and limits', () => {
  test('the page mirrors the server: first-word timeout 5 to 300 seconds', () => {
    assert.deepEqual({ ...LIMITS.timeoutSec }, { min: 5, max: 300 });
    // the whole mirror agrees with the server, not just the timeout
    for (const [key, value] of Object.entries(LIMITS)) assert.deepEqual(value, SERVER_LIMITS[key], key);
  });

  test('the General tab hints say what the numbers are', () => {
    const src = readFileSync(new URL('../../public/js/components/settings-general.js', import.meta.url), 'utf8');
    assert.ok(src.includes('The default fits a 4,096-token window. For a 2,048-token window use about 1,500; raise it only after raising the model\\\'s window (Ollama: OLLAMA_CONTEXT_LENGTH).'));
    assert.match(src, /LIMITS\.timeoutSec\.min\} to \$\{LIMITS\.timeoutSec\.max\} seconds/);
  });

  test('every suggested local model has an honest card: measured ones say so, the others say they are not', () => {
    const local = describeProviders({}).find((r) => r.id === 'local');
    for (const m of local.suggestedModels) {
      const card = describeSmallModel(m);
      assert.ok(card.size && card.tier && card.blurb, `${m.id} has a size, a tier and a note`);
    }
    const byId = Object.fromEntries(local.suggestedModels.map((m) => [m.id, describeSmallModel(m)]));
    assert.equal(byId['llama3.2:3b'].tier, 'Recommended');
    assert.equal(byId['qwen3:1.7b'].tier, 'Best measured');
    assert.equal(byId['llama3.2:1b'].tier, 'Basic');
    for (const id of ['qwen2.5:1.5b', 'gemma2:2b', 'smollm2:1.7b']) {
      assert.equal(byId[id].tier, 'Not measured', id);
      assert.match(byId[id].blurb, /did not measure/, id);
    }
  });
});

/* ============================================================ the Data tab privacy sentence */
describe('Data tab: what the provider receives', () => {
  test('replies keep their sentence', () => {
    assert.match(DATA_SENT_WITH_A_REPLY, /each reply sends the current conversation/);
    assert.match(DATA_SENT_WITH_A_REPLY, /and nothing else\.$/);
  });

  test('wrap-up and the weekly reflection send more, and the sentence says so', () => {
    assert.match(DATA_SENT_WITH_AI_STEPS, /wrap-up/i);
    assert.match(DATA_SENT_WITH_AI_STEPS, /existing memories/);
    assert.match(DATA_SENT_WITH_AI_STEPS, /entry text/);
    assert.match(DATA_SENT_WITH_AI_STEPS, /title/);
    assert.match(DATA_SENT_WITH_AI_STEPS, /summary/);
    assert.match(DATA_SENT_WITH_AI_STEPS, /weekly reflection/i);
    assert.match(DATA_SENT_WITH_AI_STEPS, /titles, summaries, mood, feelings and tags/);
    assert.match(DATA_SENT_WITH_AI_STEPS, /up to 200/);
    assert.match(DATA_SENT_WITH_AI_STEPS, /non-private/);
  });

  test('docs/PRIVACY.md says the same things (the copy module is the single source, the page is its long form)', () => {
    const page = readFileSync(new URL('../../docs/PRIVACY.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    for (const fact of ['up to 12 of your existing memories', 'up to 200 non-private entries', 'mood, feelings and tags', 'the title, summary, feelings and tags', 'privacy-copy.js']) {
      assert.ok(page.includes(fact), `docs/PRIVACY.md says: ${fact}`);
    }
    // every number the Data tab quotes is the number the server uses
    assert.match(DATA_SENT_WITH_AI_STEPS, /up to 12 of your existing memories/);
    assert.match(DATA_SENT_WITH_AI_STEPS, /up to 200 non-private entries/);
  });
});
