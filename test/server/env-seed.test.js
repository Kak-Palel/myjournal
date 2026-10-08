// Environment seeds (OPENAI_BASE_URL, LOCAL_LLM_BASE_URL, LOCAL_LLM_MODEL), end to end through the real app.
//
// Contract: the variables start a FRESH install only (no settings document saved yet). The first Save writes the
// document, seeds included, and from then on the environment never overrides a stored field, so a person can also pick
// the built-in default on purpose. API keys are different: the environment fills the gap at use time, always.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { clearOpenAIQuirks } from '../../src/providers/openai.js';
import { createApp } from '../../src/server/app.js';
import { loadEffectiveSettings } from '../../src/server/ai-service.js';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { rawRequest } from './helpers.js';

const DEFAULT_LOCAL_URL = 'http://localhost:11434/v1';
// What docker-compose.yml passes to the app container when the `ollama` profile is used.
const COMPOSE_ENV = Object.freeze({ LOCAL_LLM_BASE_URL: 'http://ollama:11434/v1', LOCAL_LLM_MODEL: 'llama3.2:3b', OPENAI_BASE_URL: '' });

/** A data folder that outlives app restarts. */
function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'myjournal-seed-'));
  const file = join(dir, 'journal.db');
  return {
    dir,
    file,
    /** Start the app on this folder with this environment, like one `npm start`. */
    async boot(env = {}) {
      clearOpenAIQuirks();
      const db = openDb({ file });
      const config = loadConfig({ ...env, JOURNAL_DATA_DIR: dir }, { overrides: { port: 0, quiet: true, shutdownGraceMs: 300 } });
      const app = createApp({ config, db });
      const { url } = await app.listen();
      const call = (method, path, body) => rawRequest(url, method, path, { body });
      return {
        db,
        get: (path) => call('GET', path),
        put: (path, body) => call('PUT', path, body),
        post: (path, body) => call('POST', path, body),
        local: async () => (await call('GET', '/api/settings')).json.ai.providers.local,
        openai: async () => (await call('GET', '/api/settings')).json.ai.providers.openai,
        async stop() {
          await app.close();
          db.close();
        },
      };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function withHome(fn) {
  const home = makeHome();
  try {
    await fn(home);
  } finally {
    home.cleanup();
  }
}

describe('environment seeds start a fresh install only', () => {
  it('docker-compose scenario: GET shows the seed, the person changes it and saves, it stays theirs after a restart', async () => {
    await withHome(async (home) => {
      let app = await home.boot(COMPOSE_ENV);
      try {
        // fresh DB: the seed is shown
        assert.equal(app.db.settings.exists(), false);
        const first = await app.local();
        assert.equal(first.baseUrl, 'http://ollama:11434/v1');
        assert.equal(first.model, 'llama3.2:3b');
        assert.equal((await app.openai()).baseUrl, 'https://api.openai.com/v1', 'an empty variable (compose passes OPENAI_BASE_URL=) seeds nothing');
        assert.equal(app.db.settings.exists(), false, 'looking at the settings does not save them');

        // the person changes the address and saves
        const put = await app.put('/api/settings', { ai: { providers: { local: { baseUrl: 'http://host.docker.internal:11434/v1' } } } });
        assert.equal(put.status, 200);
        assert.equal(put.json.ai.providers.local.baseUrl, 'http://host.docker.internal:11434/v1', 'the answer to PUT is the person\'s value');
        assert.equal((await app.local()).baseUrl, 'http://host.docker.internal:11434/v1', 'and so is the next GET');
        assert.equal(app.db.settings.exists(), true);
        // the seeded model was written explicitly together with the document
        assert.equal(app.db.settings.get().ai.providers.local.model, 'llama3.2:3b');
        await app.stop();

        // restart with the same environment: still the person's value
        app = await home.boot(COMPOSE_ENV);
        assert.equal((await app.local()).baseUrl, 'http://host.docker.internal:11434/v1');
        assert.equal((await app.local()).model, 'llama3.2:3b');
      } finally {
        await app.stop();
      }
    });
  });

  it('a person can always choose the built-in default value; the environment no longer takes it back', async () => {
    await withHome(async (home) => {
      let app = await home.boot(COMPOSE_ENV);
      try {
        assert.equal((await app.local()).baseUrl, 'http://ollama:11434/v1');
        const put = await app.put('/api/settings', { ai: { providers: { local: { baseUrl: DEFAULT_LOCAL_URL, model: 'llama3.2:3b' } } } });
        assert.equal(put.json.ai.providers.local.baseUrl, DEFAULT_LOCAL_URL, 'the answer shows the built-in default, not the variable');
        assert.equal((await app.local()).baseUrl, DEFAULT_LOCAL_URL, 'GET too (it used to show the environment value again)');
        await app.stop();
        app = await home.boot(COMPOSE_ENV);
        assert.equal((await app.local()).baseUrl, DEFAULT_LOCAL_URL, 'and after a restart');
        // empty means "built-in default" for the person as well
        await app.put('/api/settings', { ai: { providers: { local: { baseUrl: 'http://lan:1234/v1' } } } });
        const reset = await app.put('/api/settings', { ai: { providers: { local: { baseUrl: '' } } } });
        assert.equal(reset.json.ai.providers.local.baseUrl, DEFAULT_LOCAL_URL);
      } finally {
        await app.stop();
      }
    });
  });

  it('after the first save the environment is out of it: changing a variable between restarts has no effect', async () => {
    await withHome(async (home) => {
      const env1 = { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', LOCAL_LLM_BASE_URL: 'http://ollama:11434/v1', LOCAL_LLM_MODEL: 'qwen2.5:1.5b' };
      let app = await home.boot(env1);
      try {
        assert.equal((await app.openai()).baseUrl, 'https://openrouter.ai/api/v1');
        // an unrelated first save persists what the person saw, seeds included (documented in section 5)
        await app.put('/api/settings', { ai: { temperature: 0.5 } });
        const stored = app.db.settings.get();
        assert.equal(stored.ai.providers.openai.baseUrl, 'https://openrouter.ai/api/v1');
        assert.equal(stored.ai.providers.local.baseUrl, 'http://ollama:11434/v1');
        assert.equal(stored.ai.providers.local.model, 'qwen2.5:1.5b');
        await app.stop();

        app = await home.boot({ OPENAI_BASE_URL: 'https://api.groq.com/openai/v1', LOCAL_LLM_BASE_URL: 'http://elsewhere:9/v1', LOCAL_LLM_MODEL: 'gemma2:2b' });
        assert.equal((await app.openai()).baseUrl, 'https://openrouter.ai/api/v1');
        const local = await app.local();
        assert.deepEqual([local.baseUrl, local.model], ['http://ollama:11434/v1', 'qwen2.5:1.5b']);
        await app.stop();

        // ... and with the variables gone entirely
        app = await home.boot({});
        assert.equal((await app.local()).baseUrl, 'http://ollama:11434/v1');
      } finally {
        await app.stop();
      }
    });
  });

  it('until the first save the install is still fresh and follows the environment', async () => {
    await withHome(async (home) => {
      let app = await home.boot({ LOCAL_LLM_BASE_URL: 'http://ollama:11434/v1' });
      assert.equal((await app.local()).baseUrl, 'http://ollama:11434/v1');
      await app.stop();
      app = await home.boot({ LOCAL_LLM_BASE_URL: 'http://other:11434/v1' });
      try {
        assert.equal((await app.local()).baseUrl, 'http://other:11434/v1');
        assert.equal(app.db.settings.exists(), false);
        // a rejected save writes nothing and keeps the install fresh
        const bad = await app.put('/api/settings', { ai: { temperature: 'hot' } });
        assert.equal(bad.status, 400);
        assert.equal(app.db.settings.exists(), false);
      } finally {
        await app.stop();
      }
    });
  });

  it('invalid variables are ignored; the built-in defaults apply', async () => {
    await withHome(async (home) => {
      const app = await home.boot({ OPENAI_BASE_URL: 'javascript:alert(1)', LOCAL_LLM_BASE_URL: 'http://user:pw@host/v1', LOCAL_LLM_MODEL: 'x'.repeat(300) });
      try {
        const local = await app.local();
        assert.deepEqual([local.baseUrl, local.model], [DEFAULT_LOCAL_URL, 'llama3.2:3b']);
        assert.equal((await app.openai()).baseUrl, 'https://api.openai.com/v1');
      } finally {
        await app.stop();
      }
    });
  });

  it('"delete everything" with settings makes the install fresh again, and the environment seeds it again', async () => {
    await withHome(async (home) => {
      const app = await home.boot(COMPOSE_ENV);
      try {
        await app.put('/api/settings', { ai: { providers: { local: { baseUrl: 'http://lan:1234/v1' } } } });
        assert.equal((await app.local()).baseUrl, 'http://lan:1234/v1');
        const wipe = await app.post('/api/data/wipe', { confirm: 'DELETE', includeSettings: true });
        assert.equal(wipe.status, 200);
        assert.equal(app.db.settings.exists(), false);
        assert.equal((await app.local()).baseUrl, 'http://ollama:11434/v1');
      } finally {
        await app.stop();
      }
    });
  });

  it('the providers really use the seeded address on a fresh install, and the saved one afterwards', async () => {
    const seeded = await createMockOpenAI({});
    const chosen = await createMockOpenAI({});
    try {
      await withHome(async (home) => {
        const app = await home.boot({ LOCAL_LLM_BASE_URL: seeded.baseUrl });
        try {
          const first = await app.post('/api/providers/test', { provider: 'local' });
          assert.equal(first.json.ok, true);
          assert.equal(seeded.chatRequests().length, 1);
          await app.put('/api/settings', { ai: { providers: { local: { baseUrl: chosen.baseUrl } } } });
          const second = await app.post('/api/providers/test', { provider: 'local' });
          assert.equal(second.json.ok, true);
          assert.equal(chosen.chatRequests().length, 1, 'the saved address is used');
          assert.equal(seeded.chatRequests().length, 1, 'the environment\'s is not');
        } finally {
          await app.stop();
        }
      });
    } finally {
      await seeded.close();
      await chosen.close();
    }
  });
});

describe('API keys keep working the way they always did, before and after the first save', () => {
  const ENV_KEY = 'env-gemini-key-AAAA1111';
  const SAVED_KEY = 'saved-gemini-key-BBBB2222';

  it('the environment fills the gap, a saved key wins, clearing it brings the environment back, and env keys are never stored', async () => {
    await withHome(async (home) => {
      const app = await home.boot({ GEMINI_API_KEY: ENV_KEY, LOCAL_LLM_BASE_URL: 'http://ollama:11434/v1' });
      try {
        const row = async () => (await app.get('/api/providers')).json.providers.find((p) => p.id === 'gemini');
        assert.deepEqual([(await row()).configured, (await row()).keySource], [true, 'env']);

        // the first save (of something unrelated) does not turn the environment key into a saved one
        await app.put('/api/settings', { ai: { temperature: 0.4 } });
        assert.equal(app.db.settings.get().ai.providers.gemini.apiKey, '');
        assert.equal((await row()).keySource, 'env');
        assert.equal((await app.get('/api/settings')).json.ai.providers.gemini.apiKeySource, 'env');

        await app.put('/api/settings', { ai: { providers: { gemini: { apiKey: SAVED_KEY } } } });
        assert.equal((await row()).keySource, 'settings');
        assert.equal((await app.get('/api/settings')).json.ai.providers.gemini.apiKeyHint, '…2222');

        await app.put('/api/settings', { ai: { providers: { gemini: { apiKey: null } } } });
        assert.equal((await row()).keySource, 'env');
        assert.equal((await app.get('/api/settings')).json.ai.providers.gemini.apiKeyHint, '…1111');
        const raw = JSON.stringify(app.db.settings.get());
        assert.ok(!raw.includes(ENV_KEY), 'the environment key was never written to the database');
        assert.equal((await app.get('/api/settings')).text.includes(ENV_KEY), false);
      } finally {
        await app.stop();
      }
    });
  });
});

describe('loadEffectiveSettings', () => {
  const fakeDb = (stored, exists) => ({ settings: { get: () => structuredClone(stored), exists: () => exists } });
  const env = { LOCAL_LLM_BASE_URL: 'http://ollama:11434/v1', LOCAL_LLM_MODEL: 'qwen2.5:1.5b', OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' };

  it('seeds a fresh install and leaves a saved document alone, even when its values equal the built-in defaults', () => {
    const defaults = openDb({ file: ':memory:' });
    try {
      const fresh = loadEffectiveSettings(defaults, env);
      assert.equal(fresh.ai.providers.local.baseUrl, 'http://ollama:11434/v1');
      assert.equal(fresh.ai.providers.local.model, 'qwen2.5:1.5b');
      assert.equal(fresh.ai.providers.openai.baseUrl, 'https://openrouter.ai/api/v1');
      // what is stored is still the untouched default: nothing was written by reading
      assert.equal(defaults.settings.exists(), false);

      defaults.settings.set(defaults.settings.get()); // the person saved the defaults
      const saved = loadEffectiveSettings(defaults, env);
      assert.equal(saved.ai.providers.local.baseUrl, DEFAULT_LOCAL_URL);
      assert.equal(saved.ai.providers.local.model, 'llama3.2:3b');
      assert.equal(saved.ai.providers.openai.baseUrl, 'https://api.openai.com/v1');
    } finally {
      defaults.close();
    }
  });

  it('works with any store that has get() and exists(), and an empty environment changes nothing', () => {
    const stored = { ai: { providers: { local: { baseUrl: 'http://lan:1/v1' } } } };
    assert.equal(loadEffectiveSettings(fakeDb(stored, true), env).ai.providers.local.baseUrl, 'http://lan:1/v1');
    assert.equal(loadEffectiveSettings(fakeDb({}, false), {}).ai.providers.local.baseUrl, DEFAULT_LOCAL_URL);
  });
});
