import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./setup.mjs', import.meta.url));
const currentMask = '{features,decisions}/**/*.md';
const qmd = (process.env.PATH || '').split(delimiter)
  .map(dir => resolve(dir, 'qmd')).find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
    catch { return false; }
  });
const integration = { skip: qmd ? false : 'installed QMD required for isolated collection verification' };
const YAML = qmd ? createRequire(realpathSync(qmd))('yaml') : null;

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'qmd-current-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'corpus with spaces');
  const config = join(cwd, 'config', 'index.yml');
  // Isolate every QMD storage location before invoking even --version.
  const env = {
    ...process.env,
    QMD_CONFIG_DIR: dirname(config), INDEX_PATH: join(cwd, 'index.sqlite'),
    XDG_CONFIG_HOME: join(cwd, 'xdg-config'), XDG_CACHE_HOME: join(cwd, 'cache'),
    PWD: cwd, NO_COLOR: '1',
  };
  async function run(name, ...args) {
    try {
      const { stdout } = await execute(name, args, { cwd, env, timeout: 60000 });
      return stdout;
    } catch (error) {
      error.message += `\n${name} ${args.join(' ')}\n${error.stdout || ''}\n${error.stderr || ''}`;
      throw error;
    }
  }
  async function readConfig() {
    // Read supported YAML independently of the setup command.
    return YAML.parse(await readFile(config, 'utf8'));
  }
  async function membership(collection) {
    return ((await run(qmd, 'ls', collection)).match(/qmd:\/\/[^\s]+/g) || []).sort();
  }
  async function search(word, collection) {
    return JSON.parse(await run(qmd, 'search', word, '-c', collection, '--json'));
  }
  return { cwd, root, config, run, readConfig, membership, search };
}

describe('QMD current setup', { concurrency: true }, () => {
  for (const scenario of ['fresh', 'wrong-root', 'wrong-pattern', 'ignore-wrong-scope',
    'ignore-correct-scope', 'anchored-current', 'aliased-current']) {
    test(scenario, integration, async t => {
      const f = await fixture(t);
      t.diagnostic(`installed version: ${(await f.run(qmd, '--version')).trim()}`);
      const included = {
        'features/feature.md': 'quasarfeature', 'features/nested/nested.md': 'quasarnestedfeature',
        'decisions/decision.md': 'quasardecision', 'decisions/nested/nested.md': 'quasarnesteddecision',
      };
      const excluded = {
        'specs/historical.md': 'quasarspec', 'knowledge/codebase/history.md': 'quasarhistory',
        'knowledge/architecture/other.md': 'quasarother', 'knowledge/features/plain.txt': 'quasarfeaturetext',
        'knowledge/decisions/plain.txt': 'quasardecisiontext',
      };
      const knowledge = join(f.root, 'docs', 'knowledge');
      for (const [path, word] of Object.entries(included)) {
        await write(join(knowledge, path), `# Current explanation\n\n${word}\n`);
      }
      for (const [path, word] of Object.entries(excluded)) {
        await write(join(f.root, 'docs', path), `# Excluded explanation\n\n${word}\n`);
      }
      await write(join(f.root, 'notes', 'operator.md'), '# Operator\n\nquasaroperator\n');
      const canonical = await realpath(knowledge);
      let collections = {
        'pyrycode-docs': {
          path: join(f.root, 'docs'), pattern: '**/*', ignore: ['unrelated/**'],
          context: { '/': 'Broad collection', '/knowledge/features': 'Feature path' },
        },
        'operator-notes': {
          path: join(f.root, 'notes'), pattern: '**/*.md', includeByDefault: false,
          context: { '/': 'Other collection', '/operator.md': 'Leaf context' },
        },
      };
      if (scenario !== 'fresh') {
        collections['pyrycode-current'] = {
          path: scenario === 'wrong-root' ? join(f.root, 'docs') : knowledge,
          pattern: scenario === 'wrong-root' ? currentMask : '**/*',
          includeByDefault: false,
          context: { '/': 'Current collection', '/features': 'Current features', '/features/nested': 'Nested path' },
        };
        const current = collections['pyrycode-current'];
        switch (scenario) {
          case 'ignore-wrong-scope':
            current.path = join(f.root, 'docs');
            current.ignore = ['**/features/**'];
            break;
          case 'ignore-correct-scope':
            current.path = canonical;
            current.pattern = currentMask;
            current.ignore = ['features/**'];
            break;
          case 'anchored-current':
          case 'aliased-current':
            current.path = join(f.root, 'docs');
            break;
        }
      }
      let seed = {
        collections, global_context: 'Global context: ää\nsecond line',
        models: { embed: 'custom-preserved-model' },
      };
      await write(f.config, JSON.stringify(seed));
      if (scenario === 'anchored-current' || scenario === 'aliased-current') {
        const [anchor, alias] = scenario === 'anchored-current'
          ? ['pyrycode-current', 'pyrycode-docs'] : ['pyrycode-docs', 'pyrycode-current'];
        // Real YAML sharing is accepted and indexed by QMD before reconciliation.
        await write(f.config, `collections:\n  ${anchor}: &shared ${JSON.stringify(collections['pyrycode-current'])}`
          + `\n  ${alias}: *shared\n  operator-notes: ${JSON.stringify(collections['operator-notes'])}`
          + `\nglobal_context: ${JSON.stringify(seed.global_context)}\nmodels: ${JSON.stringify(seed.models)}\n`);
      }
      // JSON also detaches aliases in the expected value so preservation is checked independently.
      seed = JSON.parse(JSON.stringify(await f.readConfig()));
      collections = seed.collections;
      await f.run(qmd, 'update');
      const contexts = await f.run(qmd, 'context', 'list');
      const otherMembership = {};
      for (const collection of ['pyrycode-docs', 'operator-notes']) {
        otherMembership[collection] = await f.membership(collection);
      }
      if (scenario === 'wrong-pattern') {
        assert.ok((await f.membership('pyrycode-current')).length > Object.keys(included).length,
          'incorrect scope control must index excluded documents');
      }
      if (scenario.startsWith('ignore-')) {
        const before = await f.membership('pyrycode-current');
        assert.ok(before.length > 0 && !before.join('\n').includes('/features/'),
          `ignore control must exclude feature documents: ${before}`);
      }
      await f.run(process.execPath, script, '--repo', f.root);
      if (scenario === 'fresh') collections['pyrycode-current'] = {};
      const current = collections['pyrycode-current'];
      current.path = canonical;
      current.pattern = currentMask;
      delete current.ignore;
      const first = await readFile(f.config);
      await f.run(process.execPath, script, '--repo', f.root);
      assert.deepEqual(await readFile(f.config), first, 'rerun must leave configuration bytes unchanged');
      await f.run(qmd, 'update');
      for (const [collection, before] of Object.entries(otherMembership)) {
        assert.deepEqual(await f.membership(collection), before, `${collection} membership must be preserved`);
      }
      assert.equal(await f.run(qmd, 'context', 'list'), contexts, 'CLI contexts must be preserved');
      const expected = Object.keys(included).map(path => `qmd://pyrycode-current/${path}`).sort();
      assert.deepEqual(await f.membership('pyrycode-current'), expected, 'indexed membership must match exactly');
      t.diagnostic(`membership ${expected.length}: ${expected.join(', ')}`);
      for (const [path, word] of Object.entries(included)) {
        const results = await f.search(word, 'pyrycode-current');
        assert.equal(results.length, 1, `included search ${word}`);
        assert.equal(results[0].file, `qmd://pyrycode-current/${path}`, `included search ${word}`);
      }
      for (const [path, word] of Object.entries(excluded)) {
        assert.deepEqual(await f.search(word, 'pyrycode-current'), [], `excluded search ${word}`);
        const results = await f.search(word, 'pyrycode-docs');
        assert.equal(results.length, 1, `broad positive control ${word}`);
        assert.equal(results[0].file, `qmd://pyrycode-docs/${path}`, `broad positive control ${word}`);
      }
      assert.deepEqual(await f.readConfig(), seed, 'complete resolved configuration must be preserved');
      t.diagnostic('PASS: setup, rerun, collection/context preservation, 4 included searches, 5 excluded searches and 5 broad positive controls');
    });
  }

  test('default/invalid-config', integration, async t => {
    const f = await fixture(t);
    // Use the shipped script in a temporary sibling layout to test its default without a real checkout.
    const defaultScript = join(f.cwd, 'agents', 'container', 'qmd-current', 'setup.mjs');
    const knowledge = join(f.cwd, 'pyrycode', 'docs', 'knowledge');
    await mkdir(dirname(defaultScript), { recursive: true });
    await copyFile(script, defaultScript);
    for (const section of ['features', 'decisions']) {
      await mkdir(join(knowledge, section), { recursive: true });
    }
    await f.run(process.execPath, defaultScript);
    const current = (await f.readConfig()).collections['pyrycode-current'];
    assert.equal(current.path, await realpath(knowledge), 'default sibling checkout scope');
    assert.equal(current.pattern, currentMask, 'default checkout pattern');
    for (const invalid of ['collections: [', 'collections: []', 'collections:\n  pyrycode-current: invalid']) {
      await write(f.config, invalid);
      await assert.rejects(f.run(process.execPath, defaultScript), `must reject invalid configuration: ${invalid}`);
      assert.equal(await readFile(f.config, 'utf8'), invalid, 'invalid configuration must remain intact');
    }
  });
});
