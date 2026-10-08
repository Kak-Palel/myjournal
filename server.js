// MyJournal entry point:  npm start
// Loads .env, reads the configuration, opens the database, starts the HTTP server and shuts down cleanly.

import { openDb, DbError } from './src/db/index.js';
import { ConfigError, assertSafeToStart, loadConfig, loadDotEnv } from './src/config.js';
import { createApp, ListenError } from './src/server/app.js';
import { formatBanner } from './src/server/banner.js';
import { ignoreStdioErrors } from './src/server/logger.js';
import { applyEnvSeed } from './src/settings.js';

function fail(message, hint) {
  process.stderr.write(`\nMyJournal could not start.\n  ${message}\n${hint ? `  ${hint}\n` : ''}\n`);
  process.exit(1);
}

async function main() {
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
  process.stdout.write(formatBanner({ config, url: address.url, settings: applyEnvSeed(db.settings.get(), config.env) }));
}

// A bug in one request must not take the journal down; the details go to the terminal.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`error: unhandled rejection: ${reason && reason.stack ? reason.stack : reason}\n`);
});

main().catch((err) => {
  process.stderr.write(`\nMyJournal crashed while starting: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
