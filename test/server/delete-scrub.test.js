// Deleting something through the API must make its text unreadable in the database files right away, not only after the next
// checkpoint or clean shutdown (docs/PRIVACY.md "Deleting things"). A kill -9 or a power cut must not leave it in journal.db-wal.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { withApp } from './helpers.js';

const filesContaining = (dir, token) => readdirSync(dir)
  .filter((name) => name.startsWith('journal.db') && readFileSync(join(dir, name)).toString('latin1').includes(token));

describe('deleting leaves nothing readable in the database files', () => {
  it('an entry, a message, a memory, all memories and a report', async () => {
    await withApp({ ai: false }, async (h) => {
      const checkpoint = () => h.db.handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const gone = async (tokens, remove) => {
        checkpoint(); // everything is in the main file, the worst case for a delete
        for (const token of tokens) assert.ok(filesContaining(h.dir, token).length > 0, `${token} must be in the file before the delete`);
        await remove();
        for (const token of tokens) assert.deepEqual(filesContaining(h.dir, token), [], `${token} is still readable after the delete`);
      };

      const { entry } = await h.entry({ content: 'keepmeqq first message' });
      const doomed = await h.entry({ title: 'delentrytitleqq', content: 'delentrybodyqq words' });
      await gone(['delentrybodyqq', 'delentrytitleqq'], async () => assert.equal((await h.del(`/api/entries/${doomed.entry.id}`)).status, 204));

      const added = await h.post(`/api/entries/${entry.id}/messages`, { content: 'delmessagebodyqq words' });
      await gone(['delmessagebodyqq'], async () => assert.equal((await h.del(`/api/entries/${entry.id}/messages/${added.json.message.id}`)).status, 200));

      const mem = await h.post('/api/memories', { text: 'delmemoryqq fact' });
      await gone(['delmemoryqq'], async () => assert.equal((await h.del(`/api/memories/${mem.json.memory.id}`)).status, 204));

      await h.post('/api/memories', { text: 'clearmemoryqq fact' });
      await gone(['clearmemoryqq'], async () => assert.equal((await h.post('/api/memories/clear')).json.removed, 1));

      const report = h.db.reports.create({ periodStart: '2026-10-01', periodEnd: '2026-10-07', content: 'delreportqq text' });
      await gone(['delreportqq'], async () => assert.equal((await h.del(`/api/insights/reports/${report.id}`)).status, 204));

      const kept = await h.get(`/api/entries/${entry.id}`);
      assert.equal(kept.status, 200, 'the other entry is untouched');
      assert.equal(kept.json.messages[0].content, 'keepmeqq first message');
    });
  });
});
