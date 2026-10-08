// Welcome screen (bare layout). Pick how the companion thinks - or skip AI entirely. Choosing saves
// `onboarded: true` plus the provider via app.saveSettings, then opens Settings on that provider's tab
// (with setup=1 so it shows the two next steps, or the one that is left when the server already has a key in its
// environment), or Today for "no AI".
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon } from '../lib/ui.js';
import { notice } from '../components/settings-ui.js';
import { envKeysFound, envKeyBadgeText } from '../components/settings-logic.js';

/** How long the welcome screen waits for the provider list before it shows up without the "key found" badges. */
const ENV_LOOKUP_MS = 700;

/**
 * Which providers already have a key in the server's environment (GET /api/providers, `keySource: 'env'`). Best effort: any
 * failure or delay just means no badges. Only the variable's name is ever shown, never the key.
 * @returns {Promise<Record<string, string>>}
 */
async function lookUpEnvKeys(signal) {
  let timer = null;
  try {
    const answer = await Promise.race([
      api.get('/providers', { signal }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), ENV_LOOKUP_MS); }),
    ]);
    return envKeysFound(answer && answer.providers);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

const CHOICES = [
  {
    id: 'gemini', icon: 'sparkles', title: 'Free Gemini', tag: 'Recommended to start',
    tagline: 'Quickest way to try it',
    points: [
      'A free key from Google AI Studio, ready in a minute',
      'Fast, capable replies',
      'Your writing is sent to Google. The free tier may be used to improve their products, so keep secrets out of it',
    ],
    cta: 'Use Gemini',
  },
  {
    id: 'openai', icon: 'cloud', title: 'OpenAI-compatible', tag: '',
    tagline: 'OpenAI, OpenRouter, Groq, Together and more',
    points: [
      'Bring your own API key and pick any model',
      'Works with anything that speaks the OpenAI API',
      'Your writing goes to the service you choose',
    ],
    cta: 'Use my own API',
  },
  {
    id: 'local', icon: 'server', title: 'Local small model', tag: 'Most private',
    tagline: 'Nothing leaves your machine',
    points: [
      'Runs on your computer with Ollama, llama.cpp or LM Studio',
      'Free, private and works offline',
      'Small models are simpler than cloud ones, and need a one-time download',
    ],
    cta: 'Run it locally',
  },
];

export default async function onboardingView(ctx) {
  const { root, app, signal } = ctx;
  const envKeys = await lookUpEnvKeys(signal);
  if (signal.aborted) return undefined;
  let busy = false;
  const buttons = [];
  const errorSlot = h('div', { 'aria-live': 'polite' });

  function setBusy(on, activeBtn) {
    busy = on;
    for (const b of buttons) {
      b.disabled = on;
      b.classList.toggle('is-loading', on && b === activeBtn);
    }
  }

  async function choose(id, btn) {
    if (busy) return;
    mount(errorSlot);
    setBusy(true, btn);
    const patch = id === 'none'
      ? { onboarded: true, ai: { enabled: false } }
      : { onboarded: true, ai: { enabled: true, provider: id } };
    try {
      await app.saveSettings(patch);
    } catch (err) {
      if (signal.aborted) return;
      setBusy(false);
      mount(errorSlot, notice({
        tone: 'error', role: 'alert',
        children: [h('strong', null, err.message || 'Could not save your choice'), err.hint ? h('p', { class: 'muted' }, err.hint) : null, h('p', { class: 'muted' }, 'Nothing was changed. Try again.')],
      }));
      btn.focus();
      return;
    }
    app.navigate(id === 'none' ? '/' : `/settings?tab=${id}&setup=1`);
  }

  function card(c) {
    // A key the server already has (GEMINI_API_KEY, OPENAI_API_KEY): say so, and the choice then leads to a one-step setup.
    const found = envKeys[c.id] ? h('p', { class: 'onboarding-env', id: `onboarding-env-${c.id}` }, icon('key', { size: 16 }), h('span', null, envKeyBadgeText(c.id))) : null;
    const btn = h('button', {
      type: 'button', class: 'btn onboarding-choose', 'aria-describedby': found ? found.id : null, onClick: () => choose(c.id, btn),
    }, c.cta, icon('chevron-right', { size: 18 }));
    buttons.push(btn);
    return h('li', { class: ['onboarding-card', c.id === 'gemini' ? 'is-featured' : ''] },
      h('div', { class: 'onboarding-card-head' },
        h('span', { class: 'onboarding-card-icon', 'aria-hidden': 'true' }, icon(c.icon, { size: 24 })),
        c.tag ? h('span', { class: ['chip', c.id === 'gemini' ? 'chip-primary' : ''] }, c.tag) : null),
      h('h3', { class: 'onboarding-card-title' }, c.title),
      h('p', { class: 'onboarding-card-tagline' }, c.tagline),
      found,
      h('ul', { class: 'onboarding-points' }, c.points.map((p) => h('li', null, icon('check', { size: 16 }), h('span', null, p)))),
      btn);
  }

  const noAiBtn = h('button', { type: 'button', class: 'btn onboarding-none', onClick: () => choose('none', noAiBtn) }, icon('pen', { size: 16 }), 'Just journal, no AI');
  buttons.push(noAiBtn);
  const heading = h('h1', { class: 'onboarding-title', tabindex: '-1' }, 'A private place to think out loud');

  mount(root, h('div', { class: 'onboarding' },
    h('div', { class: 'onboarding-inner' },
      h('div', { class: 'onboarding-brand' }, icon('sprout', { size: 26 }), h('span', null, 'MyJournal')),
      heading,
      h('p', { class: 'onboarding-lead' },
        'Write freely. An AI companion can ask gentle follow-up questions, remember what matters to you and notice patterns, using a model you choose. Your journal itself stays on this computer.'),
      h('h2', { class: 'onboarding-question' }, 'How should your companion think?'),
      h('ul', { class: 'onboarding-cards' }, CHOICES.map(card)),
      errorSlot,
      h('div', { class: 'onboarding-none-wrap' },
        noAiBtn,
        h('p', { class: 'muted small' }, 'MyJournal is a calm, fast journal on its own. You can add an AI any time in Settings, and change your mind later.')))));

  requestAnimationFrame(() => heading.focus({ preventScroll: true }));
  return undefined;
}
