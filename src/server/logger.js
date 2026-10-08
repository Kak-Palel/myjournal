// One log line per request (`METHOD /path status 12ms`) and a few warnings/errors. Never bodies, headers,
// query strings (a search term is journal text) or keys. Everything user controlled is made printable first.

const MAX_PATH_CHARS = 160;
const guarded = new WeakSet();

/**
 * Make writes to stdout/stderr unable to crash the process. When whoever reads the terminal goes away
 * (`npm start | head`, a supervisor that closes its pipe) the next write emits 'error' on the stream, and an
 * unhandled 'error' event ends the process: the journal would go down and a running reply would be lost, only
 * because a log line had nowhere to go. A broken log pipe is not worth more than that, so the errors are dropped.
 * Safe to call more than once.
 * @param {Array<NodeJS.WritableStream>} [streams]
 */
export function ignoreStdioErrors(streams = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    if (!stream || guarded.has(stream)) continue;
    guarded.add(stream);
    stream.on('error', () => {});
  }
}

/** Printable ASCII only, shortened: a path from the network must not be able to forge log lines or colour the terminal. */
export function printable(text, max = MAX_PATH_CHARS) {
  const flat = String(text).replace(/[^\x20-\x7e]/g, '?');
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * @param {{ quiet?: boolean, logger?: { request?: Function, warn?: Function, error?: Function } }} config
 * @returns {{ request(info: {method: string, path: string, status: number, ms: number, aborted: boolean}): void,
 *            warn(message: string, err?: unknown): void, error(message: string, err?: unknown): void }}
 */
export function createLogger(config = {}) {
  const custom = config.logger || {};
  const detail = (err) => (err instanceof Error ? ` ${err.stack || err.message}` : err === undefined ? '' : ` ${printable(err, 300)}`);
  return {
    request(info) {
      if (custom.request) return custom.request(info);
      if (config.quiet) return undefined;
      const tail = info.aborted ? ' (client went away)' : '';
      process.stdout.write(`${printable(info.method, 12)} ${printable(info.path)} ${info.status} ${Math.max(0, Math.round(info.ms))}ms${tail}\n`);
      return undefined;
    },
    warn(message, err) {
      if (custom.warn) return custom.warn(message, err);
      if (!config.quiet) process.stderr.write(`warning: ${message}${detail(err)}\n`);
      return undefined;
    },
    error(message, err) {
      if (custom.error) return custom.error(message, err);
      process.stderr.write(`error: ${message}${detail(err)}\n`);
      return undefined;
    },
  };
}
