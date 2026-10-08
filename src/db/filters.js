// Entry filters shared by entries.list()/page() and search(), so both accept and validate exactly
// the same input. HTTP query strings arrive as strings ('3', '1', 'true'); programmatic callers pass
// numbers and booleans. Hard-invalid values throw DbError('invalid'); "no value" means no filter.

import { DbError, isSafeInt, isValidDate } from './util.js';

function invalid(field, message) {
  return new DbError('invalid', message, { field });
}

/** @returns {number|null} an integer 1..5, or null for null */
export function parseMood(value) {
  if (value === null) return null;
  if (isSafeInt(value) && value >= 1 && value <= 5) return value;
  throw invalid('mood', 'mood must be an integer from 1 to 5, or null');
}

/** @returns {string} the date, if it is a real `YYYY-MM-DD` calendar date */
export function parseDate(value) {
  if (isValidDate(value)) return value;
  throw invalid('date', 'date must be a real calendar date formatted YYYY-MM-DD');
}

// Query strings arrive as '1'/'true'; programmatic callers pass booleans. Anything else = no filter.
function parseFlagFilter(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  return null;
}

const isBlank = (value) => value === undefined || value === null || value === '';

/**
 * Turn the `mood`, `tag`, `from`, `to` and `pinned` options into SQL conditions on the alias `e`
 * (entries) plus their named parameters. Validates everything up front.
 * @param {{ mood?: unknown, tag?: unknown, from?: unknown, to?: unknown, pinned?: unknown }} options
 * @returns {{ where: string[], params: Record<string, string|number> }}
 * @throws {DbError} code 'invalid' for a malformed mood, tag or date
 */
export function entryFilters(options) {
  const o = options ?? {};
  const where = [];
  const params = {};
  if (!isBlank(o.mood)) {
    params.mood = parseMood(typeof o.mood === 'string' ? Number(o.mood) : o.mood);
    where.push('e.mood = :mood');
  }
  if (!isBlank(o.tag)) {
    if (typeof o.tag !== 'string') throw invalid('tag', 'tag must be text');
    const tag = o.tag.trim().toLowerCase();
    if (tag !== '') {
      params.tag = tag;
      where.push('EXISTS (SELECT 1 FROM json_each(e.tags) WHERE json_each.value = :tag)');
    }
  }
  if (!isBlank(o.from)) {
    params.from = parseDate(o.from);
    where.push('e.entry_date >= :from');
  }
  if (!isBlank(o.to)) {
    params.to = parseDate(o.to);
    where.push('e.entry_date <= :to');
  }
  const pinned = parseFlagFilter(o.pinned);
  if (pinned !== null) {
    params.pinned = pinned;
    where.push('e.pinned = :pinned');
  }
  return { where, params };
}
