// Child process used by concurrency.test.js: appends messages to an existing entry while the
// parent does the same, to exercise cross-process locking.
import { openDb } from '../../../src/db/index.js';

const [file, entryId, count, label] = process.argv.slice(2);
const db = openDb({ file });
let failures = 0;
for (let i = 0; i < Number(count); i++) {
  try {
    db.messages.add(entryId, { role: i % 2 ? 'assistant' : 'user', content: `${label} message ${i}` });
  } catch (err) {
    failures++;
    console.error(`${label} #${i}: ${err.message}`);
  }
}
db.close();
process.exit(failures === 0 ? 0 : 1);
