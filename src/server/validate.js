// Request validation helpers. Every function throws an HttpError 400 (`bad_request`) whose `fields`
// name the offending property, or 404 for ids that cannot exist.

import { badRequest, notFound } from './http.js';

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(field, message) {
  return badRequest(message, { fields: { [field]: message } });
}

/** Number of code points, without walking huge strings: anything over 2x `limit` units is "too long" anyway. */
export function charCount(text, limit) {
  if (text.length <= limit) return text.length; // code points <= UTF-16 units
  if (text.length > limit * 2) return Infinity;
  let n = 0;
  for (const _ of text) n += 1; // eslint-disable-line no-unused-vars
  return n;
}

/** @param {unknown} value @returns {boolean} a real calendar date `YYYY-MM-DD` */
export function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1000) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Server-local calendar date; only a fallback for clients that do not send theirs. */
export function localToday(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * An id from the URL. Anything that cannot be a stored id is "not found", the same answer as an unknown id.
 * @param {string} value
 * @param {string} [what]
 */
export function idParam(value, what = 'item') {
  if (typeof value !== 'string' || !ID_RE.test(value) || DANGEROUS.has(value)) throw notFound(`No such ${what}.`);
  return value;
}

/** A JSON object body, or 400. */
export function bodyObject(body) {
  if (!isPlainObject(body)) throw badRequest('The request body must be a JSON object.');
  return body;
}

const has = (obj, key) => Object.hasOwn(obj, key) && obj[key] !== undefined;

/**
 * Optional text property.
 * @param {object} obj
 * @param {string} key
 * @param {{ max: number, min?: number, trim?: boolean, nullable?: boolean }} opts
 * @returns {string|null|undefined} undefined when absent
 */
export function optString(obj, key, { max, min = 0, trim = false, nullable = false }) {
  if (!has(obj, key)) return undefined;
  const raw = obj[key];
  if (raw === null && nullable) return null;
  if (typeof raw !== 'string') throw fail(key, `${key} must be text.`);
  const value = trim ? raw.trim() : raw;
  if (value.length < min || (min > 0 && value.trim().length < min)) throw fail(key, `${key} must not be empty.`);
  if (charCount(value, max) > max) throw fail(key, `${key} must be at most ${max} characters.`);
  return value;
}

/** Required text property. */
export function reqString(obj, key, opts) {
  const value = optString(obj, key, { min: 1, ...opts });
  if (value === undefined) throw fail(key, `${key} is required.`);
  return value;
}

/** @returns {boolean|undefined} */
export function optBool(obj, key) {
  if (!has(obj, key)) return undefined;
  if (typeof obj[key] !== 'boolean') throw fail(key, `${key} must be true or false.`);
  return obj[key];
}

/** @returns {number|undefined} an integer in [min, max] */
export function optInt(obj, key, { min, max }) {
  if (!has(obj, key)) return undefined;
  const v = obj[key];
  if (!Number.isInteger(v) || v < min || v > max) throw fail(key, `${key} must be a whole number from ${min} to ${max}.`);
  return v;
}

/** @returns {number|null|undefined} mood 1..5, null to clear, undefined when absent */
export function optMood(obj, key = 'mood') {
  if (!has(obj, key)) return undefined;
  if (obj[key] === null) return null;
  return optInt(obj, key, { min: 1, max: 5 });
}

/** @returns {string|undefined} */
export function optDate(obj, key) {
  if (!has(obj, key)) return undefined;
  if (!isDate(obj[key])) throw fail(key, `${key} must be a date formatted YYYY-MM-DD.`);
  return obj[key];
}

/** @returns {string[]|undefined} a list of short labels */
export function optLabels(obj, key, { maxItems = 50, maxLength = 100 } = {}) {
  if (!has(obj, key)) return undefined;
  const list = obj[key];
  if (!Array.isArray(list) || list.length > maxItems || list.some((x) => typeof x !== 'string' || x.length > maxLength)) {
    throw fail(key, `${key} must be a list of at most ${maxItems} short texts.`);
  }
  return list;
}

/** @returns {string|undefined} one of `values` */
export function optEnum(obj, key, values) {
  if (!has(obj, key)) return undefined;
  if (typeof obj[key] !== 'string' || !values.includes(obj[key])) throw fail(key, `${key} must be one of: ${values.join(', ')}.`);
  return obj[key];
}

// ---------------------------------------------------------------------------------------------
// Query strings

/**
 * A positive integer from the query string.
 * @param {URLSearchParams} query
 * @param {string} key
 * @param {{ min?: number, max: number, fallback: number }} opts values above `max` are capped, junk is a 400
 */
export function queryInt(query, key, { min = 1, max, fallback }) {
  const raw = query.get(key);
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw fail(key, `${key} must be a whole number.`);
  return Math.min(max, Math.max(min, Number(raw)));
}

/** @returns {string|undefined} a valid `YYYY-MM-DD`, or undefined when absent */
export function queryDate(query, key) {
  const raw = query.get(key);
  if (raw === null || raw === '') return undefined;
  if (!isDate(raw)) throw fail(key, `${key} must be a date formatted YYYY-MM-DD.`);
  return raw;
}

/** @returns {string|undefined} trimmed text of at most `max` characters, or undefined when absent/blank */
export function queryText(query, key, max) {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const text = raw.trim();
  if (text === '') return undefined;
  if (charCount(text, max) > max) throw fail(key, `${key} must be at most ${max} characters.`);
  return text;
}

