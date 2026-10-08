// MyJournal entry point:  npm start
// Checks the Node.js version, loads .env, reads the configuration, opens the database, starts the HTTP server and
// shuts down cleanly.
//
// Only the dependency-free version check is imported statically. Everything else (which reaches node:sqlite)
// is loaded with import() once the check has passed: on a Node.js that is too old, a static import would fail
// with a raw "No such built-in module: node:sqlite" stack trace before any friendly message could be printed.

import { nodeVersionProblem } from './src/server/node-version.js';

function fail(message, hint) {
  process.stderr.write(`\nMyJournal could not start.\n  ${message}\n${hint ? `  ${hint}\n` : ''}\n`);
  process.exit(1);
}

async function main() {
  const tooOld = nodeVersionProblem();
  if (tooOld) {
    process.stderr.write(`\n${tooOld}\n\n`);
    process.exit(1);
  }
  const [{ openDb, DbError }, { ConfigError, assertSafeToStart, loadConfig, loadDotEnv }, { createApp, ListenError }, { formatBanner }, { ignoreStdioErrors }, { loadEffectiveSettings }] = await Promise.all([
    import('./src/db/index.js'),
    import('./src/config.js'),
    import('./src/server/app.js'),
    import('./src/server/banner.js'),
    import('./src/server/logger.js'),
    import('./src/server/ai-service.js'),
  ]);

  ignoreStdioErrors(); // `npm start | head` must not take the server down with an EPIPE
  const dotenv = loadDotEnv();
  if (dotenv.error) process.stderr.write(`warning: could not read ${dotenv.path}: ${dotenv.error}\n`);

  let config;
  try {
    config = loadConfig(process.env);
    assertSafeToStart(config);
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message, err.hint);
    throw err;
  }

  // Signal handlers go in before anything slow starts, so a Ctrl+C at any moment shuts down cleanly.
  let db = null;
  let app = null;
  let stopping = false;
  async function shutdown(signal) {
    if (stopping) {
      process.stderr.write('\nForcing exit.\n');
      process.exit(1);
    }
    stopping = true;
    process.stdout.write(`\n${signal} received: finishing up...\n`);
    try {
      if (app) await app.close(); // stops accepting, aborts running replies (their partial text is saved)
    } finally {
      if (db) db.close();
    }
    process.stdout.write('Goodbye. Your journal is saved.\n');
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    db = openDb({ file: config.dbFile });
  } catch (err) {
    if (err instanceof DbError) fail(err.message, err.code === 'schema_too_new' ? 'Update MyJournal, or point JOURNAL_DATA_DIR at another folder.' : `Check that the folder ${config.dataDir} exists and is writable.`);
    throw err;
  }

  app = createApp({ config, db });
  let address;
  try {
    address = await app.listen();
  } catch (err) {
    db.close();
    if (err instanceof ListenError) fail(err.message, err.hint);
    throw err;
  }
  process.stdout.write(formatBanner({ config, url: address.url, settings: loadEffectiveSettings(db, config.env) }));
}

// A bug in one request must not take the journal down; the details go to the terminal.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`error: unhandled rejection: ${reason && reason.stack ? reason.stack : reason}\n`);
});

main().catch((err) => {
  process.stderr.write(`\nMyJournal crashed while starting: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
