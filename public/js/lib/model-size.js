// How big is this model? Pure string work (no DOM, no network), so it is unit-tested in Node.
//
// Model names carry their size as a parameter count: "llama3.2:1b", "qwen3:1.7b", "smollm2:360m", "mistral-7b-instruct",
// "Llama-3.2-3B-Instruct-Q4_K_M.gguf", "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M". The app uses the number for one
// thing: to warn that models under about 3B write poor memory notes (docs/PROVIDERS.md, "How well small models follow the rules").

/** Below this many billion parameters a model is "small" for the memory-notes warning. */
export const SMALL_MODEL_LIMIT_B = 3;

// A count is digits (with an optional fraction) and a unit, standing alone between separators: "1b" in "llama3.2:1b" and
// "mistral-7b-instruct", but not the "2b" in "gemma2b" or the "4b" in "4bit", and not anything inside a quantisation
// suffix ("q4_k_m", "q8_0", "bf16"). The lookarounds are what keep "llama3.2" (no unit) and "qwen2.5:7b" apart.
const SIZE = /(?<![A-Za-z0-9.])(\d{1,4}(?:\.\d{1,3})?)([bm])(?![A-Za-z0-9])/i;
// Mixture-of-experts names: "mixtral:8x7b" is 8 experts of 7B each (56B stored).
const MIXTURE = /(?<![A-Za-z0-9.])(\d{1,3})x(\d{1,4}(?:\.\d{1,3})?)b(?![A-Za-z0-9])/i;

/**
 * The size of a model in billions of parameters, read from its name; null when the name does not say.
 * Registry paths, tags and quantisation suffixes are fine; only the part after the last "/" or "\" is read (so a user or
 * host name never counts). Sizes in "M" are millions: "smollm2:360m" is 0.36.
 * @param {unknown} name a model id as typed in Settings or listed by a server
 * @returns {number | null}
 * @example modelSizeB('qwen3:1.7b') // 1.7
 * @example modelSizeB('gpt-4o-mini') // null
 */
export function modelSizeB(name) {
  if (typeof name !== 'string') return null;
  const leaf = name.trim().split(/[\\/]/).pop();
  if (!leaf) return null;
  const mix = MIXTURE.exec(leaf);
  if (mix) return round(Number(mix[1]) * Number(mix[2]));
  const m = SIZE.exec(leaf);
  if (!m) return null;
  const value = Number(m[1]) / (m[2].toLowerCase() === 'm' ? 1000 : 1);
  return value > 0 ? round(value) : null;
}

// 360 / 1000 and friends are exact enough, but keep the output free of float dust (0.36000000000000004).
const round = (n) => Math.round(n * 1e6) / 1e6;

/** Is the model known to be smaller than SMALL_MODEL_LIMIT_B? An unknown size is not "small": no warning on a guess. */
export function isSmallModel(name) {
  const size = modelSizeB(name);
  return size !== null && size < SMALL_MODEL_LIMIT_B;
}
