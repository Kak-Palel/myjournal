// Static files from public/ with strict path handling.
//
// A request path is accepted only if, after ONE round of percent-decoding, it is made of plain segments:
// no "..", ".", empty segments, backslashes, NUL, control characters, ":" (drive letters, NTFS streams),
// dot files, or a leftover "%" (which means the path was encoded twice). The file must then resolve, with
// symlinks followed, to a location inside public/. Extension-less paths that match no file get index.html,
// which is how the single-page app's deep links work.

import { realpath, open } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError, notFound } from './http.js';

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
});

/** @param {string} ext lower-case extension with the dot */
export function mimeType(ext) {
  return TYPES[ext] || 'application/octet-stream';
}

const badPath = () => new HttpError(400, 'bad_request', 'That is not a valid file path.');
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Validate a raw request path (still percent-encoded, without query string) and split it into segments.
 * @param {string} rawPath e.g. "/js/app.js"
 * @returns {string[]} the segments ([] for "/")
 * @throws {HttpError} 400 for anything suspicious, 404 for dot files
 */
export function parseStaticPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) throw badPath();
  if (rawPath.includes('\\') || /%5c/i.test(rawPath)) throw badPath();
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw badPath();
  }
  // A "%" that survives decoding was encoded twice (%252e%252e): never legitimate for our files.
  if (decoded.includes('%') || decoded.includes('\\') || CONTROL_RE.test(decoded)) throw badPath();
  const parts = decoded.split('/').slice(1);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop(); // trailing slash
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.includes(':')) throw badPath();
    if (part.startsWith('.')) throw notFound('No such file.');
  }
  return parts;
}

function etagFor(st) {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

function notModified(req, etag) {
  const header = req.headers['if-none-match'];
  if (typeof header !== 'string') return false;
  return header.split(',').some((v) => v.trim() === etag || v.trim() === '*');
}

/**
 * @param {{ root: string }} opts folder to serve (public/)
 */
export function createStatic({ root }) {
  let rootReal = null;
  async function realRoot() {
    if (!rootReal) {
      try {
        rootReal = await realpath(root);
      } catch {
        return null; // the folder does not exist (yet): every lookup is "not found"
      }
    }
    return rootReal;
  }

  const inside = (base, path) => path === base || path.startsWith(base + sep);

  /** Open `segments` below the root if that is a regular file that really lives inside it. */
  async function openFile(segments) {
    const base = await realRoot();
    if (!base) return null;
    let real;
    try {
      real = await realpath(join(base, ...segments));
    } catch {
      return null;
    }
    if (!inside(base, real)) return null; // a symlink that leaves public/ is simply "not found"
    let handle;
    try {
      handle = await open(real, 'r');
      const st = await handle.stat();
      if (!st.isFile()) {
        await handle.close();
        return null;
      }
      return { handle, st, ext: extname(real).toLowerCase() };
    } catch {
      if (handle) await handle.close().catch(() => {});
      return null;
    }
  }

  return {
    /**
     * Answer a GET/HEAD request for a static file (or index.html for an extension-less unknown path).
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {string} rawPath percent-encoded path without the query
     * @throws {HttpError}
     */
    async serve(req, res, rawPath) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'This address only answers GET requests.', { headers: { Allow: 'GET, HEAD' } });
      }
      const segments = parseStaticPath(rawPath);
      let file = segments.length === 0 ? null : await openFile(segments);
      if (!file) {
        const last = segments[segments.length - 1] || '';
        const looksLikeFile = last.includes('.');
        if (looksLikeFile) throw notFound('No such file.');
        file = await openFile(['index.html']);
        if (!file) throw notFound('The app files are missing.', { hint: 'Run MyJournal from the folder that contains the public/ directory.' });
      }
      const { handle, st, ext } = file;
      try {
        const etag = etagFor(st);
        const headers = {
          'Content-Type': mimeType(ext),
          'Cache-Control': 'no-cache',
          ETag: etag,
          'Last-Modified': st.mtime.toUTCString(),
        };
        if (notModified(req, etag)) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Length': st.size });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        await pipeline(handle.createReadStream({ autoClose: false }), res).catch(() => {
          // the browser went away mid-download
        });
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}

