// Entry view: a chat-style journal conversation (ARCHITECTURE §12).
//
// Flow of a send: POST /entries/:id/messages (text is cleared only after the 201), then POST .../reply as
// SSE into a live bubble. Streaming text is appended as plain text in animation-frame batches and swapped
// for the persisted message (rendered with renderMarkdown) on `done`.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { replaceHash } from '../lib/router.js';
import { icon, emptyState, skeleton, showError, confirmDialog, copyText } from '../lib/ui.js';
import { createHeader } from '../components/entry-header.js';
import { createComposer } from '../components/entry-composer.js';
import { renderMessage } from '../components/entry-message.js';
import { createLiveBubble, createPhaseStepper } from '../components/entry-live.js';
import { renderBanner } from '../components/entry-banner.js';
import { renderSummary } from '../components/entry-summary.js';
import { describeProblem } from '../components/entry-errors.js';
import { createRevealer, isNearBottom, announcementExcerpt } from '../components/entry-stream.js';
import { removeDraft, draftKey } from '../components/entry-draft.js';
import { isSafetyMessage, trailingMessage } from '../components/entry-thread.js';

/** Last-user-message ids that already triggered an automatic reply (guards against re-render double triggers). */
const autoRequested = new Set();

const STILL_WAITING = 'Still thinking… the first reply from a local or busy model can take a while.';
const RECENT_MS = 6 * 3600 * 1000;

const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
/** A mouse-and-keyboard device: only then is it fine to focus the composer (and pop a keyboard) automatically. */
const finePointer = () => Boolean(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

/** Resolves after `ms`, or early when `signal` aborts. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function slug(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function renderNotFound(root) {
  mount(root, h('div', { class: 'page entry-page' }, emptyState({
    level: 1,
    icon: 'book',
    title: 'We cannot find that entry',
    body: 'It may have been deleted, or the link is not quite right.',
    action: h('div', { class: 'row' },
      h('a', { class: 'btn btn-primary', href: '#/history' }, 'Go to History'),
      h('a', { class: 'btn', href: '#/' }, 'Back to Today')),
  })));
}

export default async function entryView(ctx) {
  const { root, params, query, signal, app, restoring } = ctx;
  const entryId = params.id;
  const base = `/entries/${encodeURIComponent(entryId)}`;

  mount(root, h('div', { class: 'page entry-page' }, skeleton(6)));

  let loaded;
  try {
    loaded = await api.get(base, { signal });
  } catch (err) {
    if (err && err.name === 'AbortError') return undefined;
    if (err && err.status === 404) { renderNotFound(root); return undefined; }
    const host = h('div', { class: 'page entry-page' });
    mount(root, host);
    showError(host, err, { onRetry: () => app.navigate(`/entry/${encodeURIComponent(entryId)}`) });
    return undefined;
  }

  /* ----------------------------------------------------------------- state */
  let entry = loaded.entry;
  let messages = loaded.messages.slice();
  /** @type {'idle'|'posting'|'replying'|'wrapping'|'stopping'} */
  let busy = 'idle';
  let controller = null;
  /** The revealer of the reply that is being typed out, and whether its stream already ended (Stop then skips the typing). */
  let activeReveal = null;
  let disposed = false;
  let leaving = false; // entry is being deleted: stop touching the UI
  let idleOwed = false; // a run was cut short while `leaving`; if the delete fails the UI still owes the writer the idle state
  let justAdded = [];
  let storedMemories = [];
  let patchChain = Promise.resolve();
  let summaryHost = null;
  const disposers = [];

  const alive = () => !disposed && !leaving && !signal.aborted;
  const providerId = () => (app.settings && app.settings.ai && app.settings.ai.provider) || '';
  const aiReady = () => app.aiReady();
  const toastError = (message) => app.toast(message, { kind: 'error' });

  /* -------------------------------------------------------------- scrolling */
  const metrics = () => ({ scrollHeight: document.documentElement.scrollHeight, scrollTop: window.scrollY, clientHeight: window.innerHeight });
  const nearBottom = () => isNearBottom(metrics(), 160);
  function scrollToBottom(smooth = false) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
  }
  /** Run `fn`, then keep the page pinned to the bottom only if the reader was already there. */
  function keepPinned(fn, { force = false } = {}) {
    const stick = force || nearBottom();
    fn();
    if (stick) scrollToBottom(force);
  }

  /* ---------------------------------------------------------------- chrome */
  const status = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  function announce(text) {
    status.textContent = '';
    requestAnimationFrame(() => { if (!disposed) status.textContent = text; });
  }

  const messagesEl = h('div', { class: 'entry-messages' });
  const liveEl = h('div', { class: 'entry-live' });
  const askEl = h('div', { class: 'entry-ask' });
  const thread = h('section', { class: 'entry-thread', 'aria-label': 'Conversation', tabindex: '-1' }, messagesEl, liveEl, askEl);
  const bannerEl = h('div', { class: 'entry-banner-host' });
  const jump = h('button', { type: 'button', class: 'btn btn-sm entry-jump', hidden: true, onClick: () => scrollToBottom(true) }, icon('chevron-down', { size: 16 }), 'Latest');

  const header = createHeader({ entry, onPatch: patchEntry, onExport, onDelete, notify: toastError });
  const composer = createComposer({
    entryId,
    aiReady: aiReady(),
    hasMessages: messages.length > 0,
    handlers: { send: onSend, save: onSave, stop: onStop, wrapUp: onWrapUp, notify: toastError },
  });
  const dock = h('div', { class: 'entry-dock' }, bannerEl, jump, composer.el);
  mount(root, h('div', { class: 'page entry-page' }, h('h1', { class: 'sr-only' }, 'Journal entry'), header.el, thread, dock, status));

  // The writing box floats over the bottom of the page. Tell the browser how tall it is (--dock-h feeds scroll-padding in
  // base.css) so that tabbing to a control never leaves it hidden behind the box (WCAG 2.4.11 Focus Not Obscured).
  if (typeof ResizeObserver !== 'undefined') {
    const watch = new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight}px`));
    watch.observe(dock);
    disposers.push(() => { watch.disconnect(); document.documentElement.style.removeProperty('--dock-h'); });
  }

  /* ----------------------------------------------------------- small helpers */
  const isReplyAi = (m) => m.role === 'assistant' && (!m.meta || !m.meta.kind || m.meta.kind === 'reply');
  const lastMessage = () => messages[messages.length - 1] || null;
  // Safety cards are not replies: "last message" for reply purposes is the last one that is part of the conversation.
  const replyIsLast = () => { const last = trailingMessage(messages); return Boolean(last && isReplyAi(last) && !last.local); };
  const editorOpen = () => Boolean(messagesEl.querySelector('.entry-edit'));

  function childController() {
    const c = new AbortController();
    const onAbort = () => c.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    c.signal.addEventListener('abort', () => signal.removeEventListener('abort', onAbort), { once: true });
    return c;
  }

  function setBusy(next) {
    busy = next;
    composer.setBusy(next);
    thread.classList.toggle('is-busy', next !== 'idle');
    thread.setAttribute('aria-busy', next === 'replying' || next === 'wrapping' ? 'true' : 'false');
    paintAsk(); // hides "Get a reply" while something is running
    updateJump();
  }

  function upsertMessage(message) {
    const i = messages.findIndex((m) => m.id === message.id);
    if (i >= 0) messages[i] = message; else messages.push(message);
  }

  function localMessage(partial) {
    return { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, entryId, seq: -1, createdAt: Date.now(), local: true, ...partial };
  }

  function applyEntry(next) {
    entry = next;
    header.update(entry);
    composer.setCanWrap(messages.some((m) => m.role === 'user'), entry.status === 'wrapped');
    document.title = `${entry.title ? `${entry.title} · ` : ''}MyJournal`;
  }

  /* ----------------------------------------------------------- banner / problems */
  function clearProblem() { bannerEl.replaceChildren(); }
  function showProblem(problem, { onRetry } = {}) {
    if (!alive()) return;
    bannerEl.replaceChildren(renderBanner(problem, { onRetry, onDismiss: clearProblem }));
  }

  /* ------------------------------------------------------------ painting */
  const mergedMemories = () => {
    const seen = new Set();
    return [...justAdded, ...storedMemories].filter((m) => (m && m.text && !seen.has(m.id || m.text) ? seen.add(m.id || m.text) : false));
  };

  function paintSummary() {
    if (!summaryHost) return;
    const card = renderSummary(entry, { memories: mergedMemories(), justAdded: justAdded.length > 0 });
    summaryHost.replaceChildren(...(card ? [card] : []));
  }

  const handlers = {
    edit: editMessage,
    remove: removeMessage,
    regenerate: () => runReply({ regenerate: true }),
    copy: async (message) => {
      const ok = await copyText(message.content);
      app.toast(ok ? 'Copied' : 'Could not copy', { kind: ok ? 'success' : 'error', timeout: 1800 });
    },
  };

  function paintMessages() {
    if (!alive()) return;
    const last = lastMessage();
    const canRegenerate = Boolean(last && isReplyAi(last) && !last.local && aiReady());
    const lastWrap = [...messages].reverse().find((m) => m.role === 'assistant' && m.meta && m.meta.kind === 'wrapup');
    const frag = document.createDocumentFragment();
    summaryHost = null;
    if (messages.length === 0) {
      frag.append(h('p', { class: 'entry-empty' }, aiReady()
        ? 'Start with whatever is on your mind. Nothing is sent anywhere until you press Send.'
        : 'Start with whatever is on your mind. It is saved on this computer when you press Save entry.'));
    }
    for (const m of messages) {
      frag.append(renderMessage(m, { canRegenerate: canRegenerate && m === last, handlers }));
      if (lastWrap && m.id === lastWrap.id) {
        summaryHost = h('div', { class: 'entry-summary-host' });
        frag.append(summaryHost);
      }
    }
    messagesEl.replaceChildren(frag);
    paintSummary();
    composer.setHasMessages(messages.length > 0);
    composer.setCanWrap(messages.some((m) => m.role === 'user'), entry.status === 'wrapped');
    paintAsk();
  }

  function paintAsk() {
    const last = trailingMessage(messages);
    const show = busy === 'idle' && aiReady() && last && last.role === 'user' && !last.local;
    askEl.replaceChildren(...(show
      ? [h('button', { type: 'button', class: 'btn btn-sm entry-ask-btn', onClick: () => runReply() }, icon('sparkles', { size: 16 }), 'Get a reply')]
      : []));
  }

  function updateJump() {
    jump.hidden = !(busy !== 'idle' && !nearBottom());
  }

  /* ------------------------------------------------------------- server sync */
  async function syncFromServer() {
    try {
      const res = await api.get(base, { signal });
      if (!alive()) return false;
      messages = res.messages.slice();
      applyEntry(res.entry);
      paintMessages();
      return true;
    } catch {
      return false;
    }
  }

  /** After Stop the server persists the partial text on its own schedule: poll briefly until it shows up. */
  async function settleAfterStop(expectPartial) {
    for (const wait of [200, 700, 1800]) {
      await sleep(wait, signal);
      if (!alive()) return;
      try {
        const res = await api.get(base, { signal });
        const last = res.messages[res.messages.length - 1];
        if (!expectPartial || (last && last.role === 'assistant' && last.meta && last.meta.stopped)) {
          if (!alive()) return;
          messages = res.messages.slice();
          applyEntry(res.entry);
          keepPinned(paintMessages);
          return;
        }
      } catch { /* try again */ }
    }
  }

  /** @param {{ detached?: boolean }} [opts] detached = the view is closing: keep the request alive past its signal */
  function patchEntry(patch, { detached = false } = {}) {
    const run = async () => {
      const res = await api.patch(base, patch, detached ? {} : { signal });
      if (!disposed) applyEntry(res.entry);
      return res.entry;
    };
    const p = patchChain.then(run, run);
    patchChain = p.catch(() => {});
    return p;
  }

  /* --------------------------------------------------------- message editing */
  async function editMessage(message, text) {
    if (busy !== 'idle') throw new Error('Wait for the reply to finish first.');
    const res = await api.patch(`${base}/messages/${encodeURIComponent(message.id)}`, { content: text }, { signal });
    upsertMessage(res.message);
    applyEntry(res.entry);
    paintMessages();
    const edit = messagesEl.querySelector(`[data-mid="${CSS.escape(message.id)}"] .entry-act-edit`);
    if (edit) edit.focus();
    announce('Message updated.');
  }

  async function removeMessage(message) {
    if (busy !== 'idle') return;
    const ok = await confirmDialog({
      title: 'Delete this message?',
      body: 'It is removed from the entry for good. Replies from your companion stay.',
      confirmLabel: 'Delete message',
      danger: true,
    });
    if (!ok || !alive()) return;
    try {
      const res = await api.del(`${base}/messages/${encodeURIComponent(message.id)}`, { signal });
      messages = messages.filter((m) => m.id !== message.id);
      if (res && res.entry) applyEntry(res.entry);
      paintMessages();
      thread.focus({ preventScroll: true });
      announce('Message deleted.');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      toastError(err && err.message ? err.message : 'Could not delete the message.');
    }
  }

  /* -------------------------------------------------------------- sending text */
  function blockedByEditor() {
    if (!editorOpen()) return false;
    app.toast('Finish editing your message first: Save changes or Cancel.', { timeout: 4000 });
    return true;
  }

  /** POST the user's message. Resolves with the saved message, or null (text stays in the box). */
  async function saveText(text, retry) {
    try {
      const res = await api.post(`${base}/messages`, { content: text }, { signal });
      if (!alive()) return null;
      upsertMessage(res.message);
      composer.clear(text);
      applyEntry(res.entry);
      keepPinned(paintMessages, { force: true });
      return res.message;
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      showProblem(describeProblem(err, { providerId: providerId() }), { onRetry: retry });
      return null;
    }
  }

  function textToSend() {
    const text = composer.getText().trim();
    if (!text) { composer.focus(); return null; }
    if (composer.overLimit()) {
      showProblem(describeProblem({ code: 'payload_too_large' }));
      return null;
    }
    return text;
  }

  async function onSend() {
    if (busy !== 'idle' || blockedByEditor()) return;
    const text = textToSend();
    if (text === null) return;
    composer.stopDictation();
    clearProblem();
    setBusy('posting');
    const saved = await saveText(text, onSend);
    if (!saved) { if (alive()) setBusy('idle'); return; }
    await runReply();
  }

  async function onSave() {
    if (busy !== 'idle' || blockedByEditor()) return;
    const text = textToSend();
    if (text === null) return;
    composer.stopDictation();
    clearProblem();
    setBusy('posting');
    const saved = await saveText(text, onSave);
    if (!alive()) return;
    setBusy('idle');
    if (saved) { announce('Saved.'); app.toast('Saved', { kind: 'success', timeout: 1500 }); }
  }

  /* ------------------------------------------------------------------- reply */
  function handleNotice(data) {
    if (!data) return;
    if (data.kind === 'safety') {
      upsertMessage(data.message && data.message.id
        ? data.message
        : localMessage({ role: 'assistant', content: String(data.text || ''), meta: { kind: 'safety' } }));
      keepPinned(paintMessages);
    } else if (data.kind === 'warn' && data.text) {
      app.toast(String(data.text), { timeout: 7000 });
    }
  }

  async function runReply({ regenerate = false, viaSafety = false } = {}) {
    if (busy === 'replying' || busy === 'wrapping' || busy === 'stopping') return;
    // From a send the editor check already ran; for Regenerate / "Get a reply" / Retry (busy 'idle') it has not.
    if (busy === 'idle' && blockedByEditor()) return;
    clearProblem();
    setBusy('replying');
    const ctl = childController();
    controller = ctl;

    const live = createLiveBubble({ variant: 'reply' });
    liveEl.replaceChildren(live.el);
    scrollToBottom(true);
    const reveal = createRevealer({
      smooth: !reducedMotion(),
      append: (chunk) => { const stick = nearBottom(); live.append(chunk); if (stick) scrollToBottom(); else updateJump(); },
    });
    activeReveal = reveal;
    const waitTimer = setTimeout(() => live.setWait(STILL_WAITING), 8000);

    let received = '';
    let ended = null;
    let doneData = null;
    let errorPayload = null;
    let dropped = !regenerate;
    let askAsRegenerate = false;

    function finishDone(data) {
      reveal.cancel();
      keepPinned(() => {
        liveEl.replaceChildren();
        if (data && data.message) upsertMessage(data.message);
        if (data && data.entry) applyEntry(data.entry);
        paintMessages();
      });
      if (data && data.message) announce(`Reply from your companion. ${announcementExcerpt(data.message.content)}`);
    }

    const onEvent = (name, data) => {
      if (!alive()) return;
      if (!dropped) { // regenerate: the server deleted the old reply when it accepted the request
        dropped = true;
        const last = lastMessage();
        if (last && isReplyAi(last)) { messages.pop(); paintMessages(); }
      }
      if (name === 'notice') handleNotice(data);
      else if (name === 'delta') {
        const text = data && typeof data.text === 'string' ? data.text : '';
        if (text) { received += text; reveal.push(text); }
      } else if (name === 'entry') { if (data && data.entry) applyEntry(data.entry); }
      else if (name === 'done') { ended = 'done'; doneData = data; }
      else if (name === 'error') { ended = 'error'; errorPayload = (data && data.error) || data || {}; }
    };

    const retryReply = () => runReply({ regenerate: replyIsLast() });

    try {
      const res = await api.stream(`${base}/reply`, { regenerate }, { signal: ctl.signal, onEvent });
      if (!alive()) return;
      if (res.aborted) {
        await finishStopped(received, reveal);
      } else if (ended === 'done') {
        // The text may still be typing out (a provider that sends a few big frames): let it finish, at most a
        // moment, and only then swap in the saved message. Stop skips the typing.
        await reveal.finish();
        if (!alive()) return;
        finishDone(doneData);
      } else if (ended === 'error') {
        await failAfterStream(errorPayload, received, retryReply);
      } else if (ended !== 'done') {
        await failAfterStream({ code: 'network', message: 'The reply was cut off.', hint: 'The connection closed before the reply was finished. Your entry is saved.' }, received, retryReply);
      }
    } catch (err) {
      if (!alive() || (err && err.name === 'AbortError')) return;
      reveal.cancel();
      liveEl.replaceChildren();
      if (received) await syncFromServer();
      // A crisis card is persisted right after the user's message. A server that counts that card as "the last
      // message" answers 409 nothing_to_reply_to although the message is unanswered; regenerate only removes a
      // trailing *reply*, so asking that way gets the reply without needing to know which rule the server uses.
      if (err && err.code === 'nothing_to_reply_to' && !regenerate && !viaSafety && isSafetyMessage(lastMessage())) askAsRegenerate = true;
      else showProblem(describeProblem(err, { providerId: providerId() }), { onRetry: err && err.code === 'nothing_to_reply_to' ? null : retryReply });
    } finally {
      clearTimeout(waitTimer);
      reveal.cancel();
      if (activeReveal === reveal) activeReveal = null;
      if (controller === ctl) controller = null;
      ctl.abort(); // already finished: this only detaches the listener childController() put on the view's signal
      if (alive()) {
        if (liveEl.contains(live.el)) liveEl.replaceChildren();
        setBusy('idle');
        if (finePointer()) composer.focus({ preventScroll: true });
      } else if (leaving && !disposed) {
        idleOwed = true;
      }
    }
    if (askAsRegenerate) await runReply({ regenerate: true, viaSafety: true });
  }

  async function failAfterStream(error, received, retry) {
    liveEl.replaceChildren();
    const synced = await syncFromServer();
    if (!synced && received.trim()) {
      messages.push(localMessage({ role: 'assistant', content: received, meta: { kind: 'reply', stopped: true } }));
      paintMessages();
    }
    showProblem(describeProblem(error, { providerId: providerId(), source: 'stream' }), { onRetry: retry });
  }

  async function finishStopped(received, reveal) {
    reveal.cancel();
    liveEl.replaceChildren();
    setBusy('stopping');
    const partial = received.trim();
    if (partial) {
      keepPinned(() => {
        messages.push(localMessage({ role: 'assistant', content: received, meta: { kind: 'reply', stopped: true } }));
        paintMessages();
      });
    }
    announce('Stopped.');
    await settleAfterStop(Boolean(partial));
  }

  function onStop() {
    if (!controller || controller.signal.aborted) return;
    setBusy('stopping');
    if (activeReveal) activeReveal.flush(); // a finished stream that is still typing out: show it all and carry on
    controller.abort();
  }

  /* ----------------------------------------------------------------- wrap-up */
  async function onWrapUp() {
    if (busy !== 'idle' || blockedByEditor()) return;
    clearProblem();
    const pending = composer.getText();
    if (pending.trim()) {
      const text = textToSend();
      if (text === null) return;
      composer.stopDictation();
      setBusy('posting');
      const saved = await saveText(text, onWrapUp);
      if (!saved) { if (alive()) setBusy('idle'); return; }
      setBusy('idle');
    }
    if (!messages.some((m) => m.role === 'user')) {
      app.toast('Write something first, then wrap up.');
      composer.focus();
      return;
    }
    await runWrapUp();
  }

  async function runWrapUp() {
    if (!alive()) return;
    setBusy('wrapping');
    const ctl = childController();
    controller = ctl;

    const live = createLiveBubble({ variant: 'wrapup' });
    const stepper = createPhaseStepper();
    liveEl.replaceChildren(live.el, stepper.el);
    scrollToBottom(true);
    const reveal = createRevealer({
      smooth: !reducedMotion(),
      append: (chunk) => { const stick = nearBottom(); live.append(chunk); if (stick) scrollToBottom(); else updateJump(); },
    });
    activeReveal = reveal;
    const waitTimer = setTimeout(() => live.setWait(STILL_WAITING), 8000);

    let ended = null;
    let doneData = null;
    let errorPayload = null;

    function finishDone(data) {
      reveal.cancel();
      stepper.finish();
      if (data && Array.isArray(data.memories)) justAdded = data.memories;
      keepPinned(() => {
        liveEl.replaceChildren();
        if (data && data.message) upsertMessage(data.message);
        if (data && data.entry) applyEntry(data.entry);
        paintMessages();
      });
      announce(`Wrap-up complete. ${entry.summary ? announcementExcerpt(entry.summary, 240) : ''}`);
    }

    const onEvent = (name, data) => {
      if (!alive()) return;
      if (name === 'notice') handleNotice(data);
      else if (name === 'phase') { if (data && data.name) stepper.set(data.name); }
      else if (name === 'delta') { const t = data && typeof data.text === 'string' ? data.text : ''; if (t) reveal.push(t); }
      else if (name === 'entry') { if (data && data.entry) applyEntry(data.entry); }
      else if (name === 'memories') { if (data && Array.isArray(data.added)) { justAdded = data.added; paintSummary(); } }
      else if (name === 'done') { ended = 'done'; doneData = data; }
      else if (name === 'error') { ended = 'error'; errorPayload = (data && data.error) || data || {}; }
    };

    try {
      const res = await api.stream(`${base}/wrap-up`, {}, { signal: ctl.signal, onEvent });
      if (!alive()) return;
      if (res.aborted) {
        reveal.cancel();
        liveEl.replaceChildren();
        setBusy('stopping');
        app.toast('Wrap-up stopped. You can run it again any time.');
        await sleep(300, signal);
        await syncFromServer();
      } else if (ended === 'done') {
        await reveal.finish(); // the reflection may still be typing out; Stop skips that
        if (!alive()) return;
        finishDone(doneData);
      } else if (ended === 'error') {
        reveal.cancel();
        liveEl.replaceChildren();
        await syncFromServer();
        showProblem(describeProblem(errorPayload, { providerId: providerId(), source: 'stream' }), { onRetry: runWrapUp });
      } else if (ended !== 'done') {
        reveal.cancel();
        liveEl.replaceChildren();
        await syncFromServer();
        showProblem(describeProblem({ code: 'network', message: 'The wrap-up was cut off.', hint: 'The connection closed early. Your entry is saved; try again.' }, { source: 'stream' }), { onRetry: runWrapUp });
      }
    } catch (err) {
      if (!alive() || (err && err.name === 'AbortError')) return;
      reveal.cancel();
      liveEl.replaceChildren();
      showProblem(describeProblem(err, { providerId: providerId() }), { onRetry: runWrapUp });
    } finally {
      clearTimeout(waitTimer);
      reveal.cancel();
      if (activeReveal === reveal) activeReveal = null;
      if (controller === ctl) controller = null;
      ctl.abort();
      if (alive()) {
        if (liveEl.contains(live.el)) liveEl.replaceChildren();
        setBusy('idle');
      } else if (leaving && !disposed) {
        idleOwed = true;
      }
    }
  }

  /* ----------------------------------------------------------- menu actions */
  async function onExport() {
    try {
      await api.download(`${base}/export.md`, `${slug(entry.title) || 'entry'}-${entry.date || 'journal'}.md`);
    } catch (err) {
      toastError(err && err.message ? err.message : 'Could not export this entry.');
    }
  }

  async function onDelete() {
    const ok = await confirmDialog({
      title: 'Delete this entry?',
      body: 'The entry and its whole conversation are deleted for good. This cannot be undone.',
      confirmLabel: 'Delete entry',
      danger: true,
    });
    if (!ok || disposed) return;
    leaving = true;
    idleOwed = false;
    if (controller) controller.abort();
    try {
      await api.del(base);
    } catch (err) {
      leaving = false;
      toastError(err && err.message ? err.message : 'Could not delete this entry.');
      // The run we aborted skipped its own wrap-up of the UI while `leaving` was set. The entry stays, so finish
      // that now (the same way Stop does): otherwise the Stop button and half a reply stay on screen for good.
      if (idleOwed && !disposed) {
        idleOwed = false;
        liveEl.replaceChildren();
        setBusy('idle');
        await syncFromServer();
      }
      return;
    }
    removeDraft(draftKey(entryId));
    app.toast('Entry deleted', { kind: 'success' });
    app.navigate('/history');
  }

  /* -------------------------------------------------------- lifecycle wiring */
  const onScroll = () => updateJump();
  window.addEventListener('scroll', onScroll, { passive: true });
  disposers.push(() => window.removeEventListener('scroll', onScroll));

  // Anything the writer has typed but not yet saved (draft text, a title or chip still being edited) is
  // written out when the page is hidden or closed.
  const flushPending = () => { composer.flushDraft(); header.flush(); };
  window.addEventListener('pagehide', flushPending);
  const onVisibility = () => { if (document.visibilityState === 'hidden') flushPending(); };
  document.addEventListener('visibilitychange', onVisibility);
  disposers.push(() => { window.removeEventListener('pagehide', flushPending); document.removeEventListener('visibilitychange', onVisibility); });

  disposers.push(app.on('settings', () => {
    composer.setAiReady(aiReady());
    if (alive() && !editorOpen()) paintMessages();
  }));

  paintMessages();
  applyEntry(entry);

  if (messages.some((m) => m.role === 'assistant' && m.meta && m.meta.kind === 'wrapup') && !entry.private) {
    api.get('/memories', { signal }).then((res) => {
      storedMemories = (res.memories || []).filter((m) => m.sourceEntryId === entry.id);
      if (alive()) paintSummary();
    }).catch(() => { /* optional extra: the summary simply shows without it */ });
  }

  requestAnimationFrame(() => {
    if (!alive()) return;
    const recent = Date.now() - (entry.updatedAt || 0) < RECENT_MS;
    if (!restoring && (query.get('reply') === '1' || (entry.status === 'open' && recent && messages.length > 0))) scrollToBottom();
    if (entry.status === 'open' && finePointer() && !controller) composer.focus({ preventScroll: true });
  });

  // ?reply=1 asks for an AI reply to a trailing user message (set by Today's "Start journaling").
  if (query.get('reply') === '1') {
    const q = new URLSearchParams(query);
    q.delete('reply');
    const qs = q.toString();
    replaceHash(`#/entry/${encodeURIComponent(entryId)}${qs ? `?${qs}` : ''}`);
    const last = lastMessage();
    if (last && last.role === 'user' && !autoRequested.has(last.id)) {
      autoRequested.add(last.id);
      if (aiReady()) runReply();
      else showProblem(describeProblem({ code: 'ai_not_configured' }, { providerId: providerId() }));
    }
  }

  return function cleanup() {
    disposed = true;
    if (activeReveal) activeReveal.cancel();
    if (controller) controller.abort();
    composer.destroy();
    header.destroy();
    for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
  };
}
