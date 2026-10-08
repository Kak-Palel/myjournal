import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { collectScripts, moduleTypeFor, runChecks, scanForbidden } from '../../scripts/check.js';

describe('scripts/check.js', () => {
  it('finds innerHTML, eval and friends but not look-alikes', () => {
    const bad = [
      'el.innerHTML = x;', 'const y = el.innerHTML', 'node.outerHTML = "<b>"', 'el.insertAdjacentHTML("beforeend", s)',
      'eval(code)', 'eval (code)', 'new Function("return 1")', 'document.write("x")',
    ];
    for (const line of bad) assert.equal(scanForbidden(line).length, 1, line);
    for (const fine of ['const retrieval = 1;', 'evaluate(x)', 'el.textContent = x;', 'const medieval = 2', 'a.innerText = b', 'functionName()']) {
      assert.deepEqual(scanForbidden(fine), [], fine);
    }
    const hits = scanForbidden('ok\nel.innerHTML = 1;\nok');
    assert.equal(hits[0].line, 2);
  });

  it('checks syntax and the public/ rules in a folder tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myjournal-check-'));
    try {
      for (const dir of ['src', 'public', 'test', 'scripts', 'node_modules/x']) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, 'server.js'), 'export const a = 1;\n');
      writeFileSync(join(root, 'src/good.js'), 'export const b = 2;\n');
      writeFileSync(join(root, 'node_modules/x/ignored.js'), 'this is not javascript (((');
      writeFileSync(join(root, 'public/app.js'), 'export const c = 3;\n');
      const messages = [];
      const clean = await runChecks({ root, log: (m) => messages.push(m) });
      assert.equal(clean.files, 3);
      assert.deepEqual([clean.syntaxErrors.length, clean.forbidden.length], [0, 0]);
      assert.match(messages.at(-1), /^OK: 3 files/);

      writeFileSync(join(root, 'src/broken.js'), 'export const = ;\n');
      writeFileSync(join(root, 'public/bad.js'), 'document.body.innerHTML = "<p>";\n');
      writeFileSync(join(root, 'src/uses-inner-html.js'), '// not under public/, so this comment is fine: innerHTML\n');
      const dirty = await runChecks({ root, log: (m) => messages.push(m) });
      assert.equal(dirty.syntaxErrors.length, 1);
      assert.match(dirty.syntaxErrors[0].file, /broken\.js$/);
      assert.equal(dirty.forbidden.length, 1);
      assert.match(dirty.forbidden[0].file, /public\/bad\.js$/);
      assert.match(messages.at(-1), /^FAILED: 1 syntax error\(s\), 1 forbidden/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression: for a .js file outside a "type": "module" package Node guesses the module type, and the guess
  // swallows syntax errors in files that use import/export. The fixtures carry their own package.json so the
  // result does not depend on where os.tmpdir() happens to be.
  describe('module type of the checked tree', () => {
    async function withTree(files, fn) {
      const root = mkdtempSync(join(tmpdir(), 'myjournal-check-'));
      try {
        // runChecks always looks at server.js, so every fixture tree has one.
        for (const [name, text] of Object.entries({ 'server.js': 'export const server = 1;\n', ...files })) {
          mkdirSync(join(root, name, '..'), { recursive: true });
          writeFileSync(join(root, name), text);
        }
        return await fn(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const quiet = () => {};

    it('reports a broken import/export file in a package without a "type"', async () => {
      await withTree({ 'package.json': '{"name":"x"}\n', 'src/broken.js': 'export const = ;\n', 'src/fine.js': 'export const a = 1;\n' }, async (root) => {
        const result = await runChecks({ root, log: quiet });
        assert.equal(result.syntaxErrors.length, 1);
        assert.match(result.syntaxErrors[0].file, /broken\.js$/);
        assert.match(result.syntaxErrors[0].message, /SyntaxError/);
        assert.match(result.syntaxErrors[0].message, /broken\.js/, 'the message names the file, not [stdin]');
      });
    });

    it('reports a broken file in a tree with no package.json at all', async () => {
      await withTree({ 'src/broken.js': 'import x from "y"\nexport const = ;\n' }, async (root) => {
        assert.equal((await runChecks({ root, log: quiet })).syntaxErrors.length, 1);
      });
    });

    it('accepts shebangs, top-level await and large files', async () => {
      const big = `export const rows = [\n${'  1,\n'.repeat(200_000)}];\n`;
      await withTree({ 'package.json': '{}', 'scripts/tool.js': '#!/usr/bin/env node\nexport const v = await Promise.resolve(1);\n', 'src/big.js': big }, async (root) => {
        const result = await runChecks({ root, log: quiet });
        assert.deepEqual(result.syntaxErrors, []);
        assert.equal(result.files, 3);
      });
    });

    it('follows "type": "commonjs", .cjs and .mjs', async () => {
      await withTree({
        'package.json': '{"type":"commonjs"}',
        'server.js': 'module.exports = 1;\n',
        'src/esm-in-cjs.js': 'export const a = 1;\n',
        'src/old.js': 'const fs = require("node:fs"); module.exports = fs;\n',
        'src/old.cjs': 'module.exports = 1;\n',
        'src/new.mjs': 'export const b = ;\n',
        'src/fine.mjs': 'export const c = await 1;\n',
      }, async (root) => {
        const result = await runChecks({ root, log: quiet });
        assert.deepEqual(result.syntaxErrors.map((e) => e.file.split('/').pop()).sort(), ['esm-in-cjs.js', 'new.mjs']);
      });
    });

    it('picks the nearest package.json and stops at the checked root', async () => {
      await withTree({ 'package.json': '{"type":"commonjs"}', 'a/package.json': '{"type":"module"}', 'a/b/x.js': '', 'c/y.js': '', 'a/z.cjs': '', 'a/w.mjs': '' }, (root) => {
        assert.equal(moduleTypeFor(join(root, 'a/b/x.js'), root), 'module');
        assert.equal(moduleTypeFor(join(root, 'c/y.js'), root), 'commonjs');
        assert.equal(moduleTypeFor(join(root, 'a/z.cjs'), root), 'commonjs');
        assert.equal(moduleTypeFor(join(root, 'a/w.mjs'), root), 'module');
      });
      await withTree({ 'src/x.js': '' }, (root) => {
        assert.equal(moduleTypeFor(join(root, 'src/x.js'), root), 'module');
      });
      await withTree({ 'package.json': '{ not json', 'x.js': '' }, (root) => {
        assert.equal(moduleTypeFor(join(root, 'x.js'), root), 'module');
      });
    });
  });

  it('collects scripts and skips node_modules', () => {
    const files = collectScripts(new URL('../../src', import.meta.url).pathname);
    assert.ok(files.some((f) => f.endsWith('src/server/app.js')));
    assert.ok(files.every((f) => !f.includes('node_modules')));
  });
});
