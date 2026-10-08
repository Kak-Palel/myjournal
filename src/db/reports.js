// Reports: AI weekly write-ups.

import { randomUUID } from 'node:crypto';
import { DbError, LIMITS, isTimestamp, isValidDate, isValidId, parseObject, sanitizeMeta } from './util.js';

export const REPORT_KINDS = ['weekly'];

function invalid(field, message) {
  return new DbError('invalid', message, { field });
}

export function toReport(r) {
  return {
    id: r.id,
    kind: r.kind,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    content: r.content,
    createdAt: r.created_at,
    meta: parseObject(r.meta),
  };
}

/**
 * @param {ReturnType<import('./context.js').createContext>} ctx
 */
export function createReports(ctx) {
  const COLUMNS = 'id, kind, period_start, period_end, content, created_at, meta';

  /** @returns {object|null} */
  function get(id) {
    if (typeof id !== 'string') return null;
    const row = ctx.one(`SELECT ${COLUMNS} FROM reports WHERE id = :id`, { id });
    return row ? toReport(row) : null;
  }

  /** Newest first. */
  function list() {
    return ctx.all(`SELECT ${COLUMNS} FROM reports ORDER BY created_at DESC, id DESC`).map(toReport);
  }

  /**
   * @param {{ kind?: 'weekly', periodStart: string, periodEnd: string, content: string,
   *   meta?: object, createdAt?: number, id?: string }} input
   * @returns {object} the Report
   * @throws {DbError} 'invalid' for bad dates, empty or over-long content
   */
  function create(input) {
    if (!input || typeof input !== 'object') throw invalid('report', 'report must be an object');
    const kind = input.kind ?? 'weekly';
    if (!REPORT_KINDS.includes(kind)) throw invalid('kind', `kind must be one of: ${REPORT_KINDS.join(', ')}`);
    if (!isValidDate(input.periodStart)) throw invalid('periodStart', 'periodStart must be a date formatted YYYY-MM-DD');
    if (!isValidDate(input.periodEnd)) throw invalid('periodEnd', 'periodEnd must be a date formatted YYYY-MM-DD');
    if (input.periodEnd < input.periodStart) throw invalid('periodEnd', 'periodEnd must not be before periodStart');
    if (typeof input.content !== 'string' || input.content.trim() === '') throw invalid('content', 'content must be non-empty text');
    if (input.content.length > LIMITS.reportContent) throw invalid('content', `content is longer than ${LIMITS.reportContent} characters`);
    if (input.id !== undefined && !isValidId(input.id)) throw invalid('id', 'id must be a short identifier');
    if (input.createdAt !== undefined && !isTimestamp(input.createdAt)) throw invalid('createdAt', 'createdAt must be a millisecond timestamp');
    const meta = sanitizeMeta(input.meta);
    const id = input.id ?? randomUUID();
    ctx.run(
      `INSERT INTO reports (id, kind, period_start, period_end, content, created_at, meta)
       VALUES (:id, :kind, :periodStart, :periodEnd, :content, :createdAt, :meta)`,
      {
        id,
        kind,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        content: input.content.replaceAll('\u0000', ''),
        createdAt: input.createdAt ?? ctx.now(),
        meta: JSON.stringify(meta),
      },
    );
    return get(id);
  }

  /** @returns {boolean} whether a report was deleted */
  function remove(id) {
    if (typeof id !== 'string') return false;
    return ctx.run('DELETE FROM reports WHERE id = :id', { id }).changes > 0;
  }

  return { list, get, create, delete: remove };
}
