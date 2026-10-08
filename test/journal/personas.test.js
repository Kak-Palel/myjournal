import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_PERSONA, CUSTOM_PERSONA_MAX_CHARS, PERSONAS, getPersona, publicPersonas, resolvePersonaPrompt,
} from '../../src/journal/personas.js';
import { estimateTokens } from '../../src/journal/tokens.js';

test('the five built-in personas exist with the expected ids, in order', () => {
  assert.deepEqual(PERSONAS.map((p) => p.id), ['companion', 'coach', 'cbt', 'stoic', 'friend']);
  assert.ok(Object.isFrozen(PERSONAS));
});

test('each persona has a name, a one-sentence description and 4-7 short imperative lines', () => {
  for (const p of PERSONAS) {
    assert.equal(typeof p.name, 'string');
    assert.ok(p.name.length > 0 && p.name.length <= 24, p.id);
    assert.ok(p.description.length > 10 && p.description.length <= 100, `${p.id} description`);
    assert.ok(/[.!]$/.test(p.description), `${p.id} description ends like a sentence`);
    const lines = p.prompt.split('\n');
    assert.ok(lines.length >= 4 && lines.length <= 7, `${p.id}: ${lines.length} lines`);
    for (const line of lines) {
      assert.ok(line.length > 15 && line.length <= 150, `${p.id}: line length ${line.length}: ${line}`);
      assert.ok(/[.!?]$/.test(line), `${p.id}: line should end with punctuation: ${line}`);
    }
    assert.ok(estimateTokens(p.prompt) <= 120, `${p.id}: persona prompt is ${estimateTokens(p.prompt)} tokens`);
  }
});

test('personas define voice only: no output-format or rule contradictions', () => {
  for (const p of PERSONAS) {
    assert.ok(!/\bTASK\b/.test(p.prompt));
    assert.ok(!/\b(?:list|bullet|json|markdown)\b/i.test(p.prompt), `${p.id} must not talk about formats`);
    assert.ok(!/\b(?:as an ai|language model)\b/i.test(p.prompt));
    assert.ok(!/\bhuman\b/i.test(p.prompt), `${p.id} must not discuss being human`);
    assert.ok(!/\bdiagnos/i.test(p.prompt) || /\bno diagnos|never diagnos|not diagnos/i.test(p.prompt), `${p.id}: diagnose only in negated form`);
  }
});

test('personas are distinct from each other', () => {
  const prompts = new Set(PERSONAS.map((p) => p.prompt));
  assert.equal(prompts.size, PERSONAS.length);
  const names = new Set(PERSONAS.map((p) => p.name));
  assert.equal(names.size, PERSONAS.length);
});

test('getPersona returns built-ins and null otherwise', () => {
  assert.equal(getPersona('stoic').id, 'stoic');
  assert.equal(getPersona('custom'), null);
  assert.equal(getPersona('nope'), null);
  assert.equal(getPersona(undefined), null);
});

test('publicPersonas hides prompts', () => {
  const list = publicPersonas();
  assert.equal(list.length, 5);
  for (const p of list) assert.deepEqual(Object.keys(p).sort(), ['description', 'id', 'name']);
  assert.equal(CUSTOM_PERSONA.id, 'custom');
});

test('resolvePersonaPrompt: built-in, default, unknown and custom', () => {
  assert.equal(resolvePersonaPrompt({ id: 'coach', custom: 'ignored' }), getPersona('coach').prompt);
  assert.equal(resolvePersonaPrompt({ id: 'companion' }), getPersona('companion').prompt);
  assert.equal(resolvePersonaPrompt(undefined), getPersona('companion').prompt);
  assert.equal(resolvePersonaPrompt(null), getPersona('companion').prompt);
  assert.equal(resolvePersonaPrompt({ id: 'wizard' }), getPersona('companion').prompt);
  assert.equal(resolvePersonaPrompt({ id: 'custom', custom: '' }), getPersona('companion').prompt, 'empty custom text falls back');
  assert.equal(resolvePersonaPrompt({ id: 'custom', custom: '  \n\t ' }), getPersona('companion').prompt);
  assert.equal(resolvePersonaPrompt({ id: 7, custom: 'x' }), getPersona('companion').prompt);
});

test('resolvePersonaPrompt: custom text is cleaned and bounded', () => {
  const out = resolvePersonaPrompt({ id: 'custom', custom: 'Be a gentle pirate.\r\n\r\n\r\n\r\nShort answers.\u0000  ' });
  assert.ok(out.includes('Be a gentle pirate.\n\nShort answers.'));
  assert.ok(!out.includes('\u0000') && !out.includes('\r'));
  const long = resolvePersonaPrompt({ id: 'custom', custom: 'é'.repeat(5000) });
  assert.ok(Array.from(long).length < CUSTOM_PERSONA_MAX_CHARS + 120);
  const emoji = resolvePersonaPrompt({ id: 'custom', custom: '😀'.repeat(3000) });
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji));
});
