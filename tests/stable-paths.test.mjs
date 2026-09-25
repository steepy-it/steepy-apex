import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { LOCAL_AREA_NAMES } from '../scripts/sanitize.mjs';
import {
  LOCAL_AREAS,
  MAX_STABLE_FILE_BYTES,
  admitHubRoot,
  bindApexRoot,
  createStableReader,
  rawPathEntersLocalArea,
  readStableDocument,
} from '../scripts/stable-paths.mjs';

function withTemp(suffix, fn) {
  const base = mkdtempSync(join(tmpdir(), `steepy-stable-paths-${suffix}-`));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function repoWithHub(base, files = { '.apex/_INDEX.md': '# Index\n' }) {
  const repo = join(base, 'repo');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  mkdirSync(repo, { recursive: true });
  return repo;
}

function messages(diagnostics) {
  return diagnostics.map(({ msg }) => msg).join('\n');
}

// Two spellings name one directory only when storage folds case onto one identity.
function sameIdentity(left, right) {
  try {
    const a = lstatSync(left, { bigint: true });
    const b = lstatSync(right, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function treeSnapshot(directory) {
  return readdirSync(directory, { recursive: true }).sort().map((entry) => {
    const stat = lstatSync(join(directory, entry), { bigint: true });
    return `${entry}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  });
}

test('root admission reports present, missing, and unsafe roots before any hub byte is read', () => {
  withTemp('admission', (base) => {
    const repo = repoWithHub(base);
    assert.deepEqual(admitHubRoot(repo), { state: 'present', root: realpathSync.native(repo) });
    assert.deepEqual(admitHubRoot(join(base, 'absent')), { state: 'missing', root: join(base, 'absent') });

    symlinkSync(repo, join(base, 'alias'), 'dir');
    writeFileSync(join(base, 'file'), 'not a directory\n');
    for (const [raw, reason] of [
      [join(base, 'alias'), 'is symlink'],
      [join(base, 'file'), 'is non-directory'],
      [`${join(base, 'file')}/../repo`, 'contains unsupported parent traversal'],
    ]) {
      const admission = admitHubRoot(raw);
      assert.equal(admission.state, 'unsafe', raw);
      assert.equal(admission.reason, reason, raw);
    }
  });
});

test('a reader over a non-admitted root collects one diagnostic and yields no bytes', () => {
  withTemp('unadmitted', (base) => {
    const sentinel = 'UNADMITTED_ROOT_SENTINEL_MUST_NOT_BE_READ';
    const repo = repoWithHub(base, {
      '.apex/_INDEX.md': `# ${sentinel}\n`,
      'AGENTS.md': `# ${sentinel}\n`,
    });
    symlinkSync(repo, join(base, 'alias'), 'dir');
    mkdirSync(join(base, 'child'));
    for (const raw of [join(base, 'alias'), `${join(base, 'child')}/../repo`]) {
      const diagnostics = [];
      const reader = createStableReader(raw, diagnostics);
      for (const path of ['.apex/_INDEX.md', 'AGENTS.md']) {
        const result = reader.read(path);
        assert.equal(result.text, undefined, `${raw}: ${path}`);
        assert.notEqual(result.state, 'present', `${raw}: ${path}`);
      }
      assert.equal(diagnostics.length, 1, messages(diagnostics));
      assert.match(diagnostics[0].msg, /^stable-read: hub root (is symlink|contains unsupported parent traversal)$/u);
      assert.doesNotMatch(messages(diagnostics), new RegExp(sentinel, 'u'));
    }

    const missing = createStableReader(join(base, 'absent'), []);
    assert.equal(missing.read('.apex/_INDEX.md').state, 'missing');
    assert.equal(missing.read('AGENTS.md').state, 'missing');
  });
});

test('a readable stable file returns its bytes with distinct logical and physical paths', () => {
  withTemp('readable', (base) => {
    const repo = repoWithHub(base, { '.apex/_INDEX.md': '# Index\n', '.apex/notes/leaf.md': '# Leaf\n' });
    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    const physicalRepo = realpathSync.native(repo);

    const result = reader.read(join('.apex', 'notes', 'leaf.md'));
    assert.equal(result.state, 'present');
    assert.equal(result.text, '# Leaf\n');
    assert.equal(result.label, '.apex/notes/leaf.md');
    assert.equal(result.path, join(physicalRepo, '.apex', 'notes', 'leaf.md'));
    assert.equal(reader.fromAbsolute(result.path), join('.apex', 'notes', 'leaf.md'));
    assert.equal(reader.inspect('leaf.md', { base: join('.apex', 'notes') }).path, result.path);
    assert.equal(reader.read('.apex/absent.md').state, 'missing');
    assert.equal(reader.inspect('.apex/notes', { kind: 'directory' }).state, 'present');
    assert.equal(reader.inspect('.apex/notes', { kind: 'entry' }).state, 'present');
    assert.deepEqual(diagnostics, []);
  });
});

test('valid relative and absolute hub mounts keep logical paths while reading the physical target', () => {
  for (const relativeLink of [false, true]) {
    withTemp(`mount-${relativeLink ? 'relative' : 'absolute'}`, (base) => {
      const repo = repoWithHub(base, { 'AGENTS.md': '# Root\n' });
      const external = join(base, 'external', 'hub');
      mkdirSync(external, { recursive: true });
      writeFileSync(join(external, '_INDEX.md'), '# External index\n');
      symlinkSync(relativeLink ? relative(repo, external) : external, join(repo, '.apex'), 'dir');

      const apex = bindApexRoot(realpathSync.native(repo));
      assert.equal(apex.state, 'present');
      assert.equal(apex.path, realpathSync.native(external));

      const diagnostics = [];
      const reader = createStableReader(repo, diagnostics);
      const result = reader.read('.apex/_INDEX.md');
      assert.equal(result.text, '# External index\n');
      assert.equal(result.label, '.apex/_INDEX.md');
      assert.equal(result.path, join(realpathSync.native(repo), '.apex', '_INDEX.md'));
      assert.equal(result.physicalPath, join(realpathSync.native(external), '_INDEX.md'));
      assert.equal(reader.read('AGENTS.md').text, '# Root\n');
      assert.deepEqual(diagnostics, []);
    });
  }
});

test('a provider mount is read through its bound physical target', () => {
  withTemp('provider-mount', (base) => {
    const repo = repoWithHub(base);
    const external = join(base, 'provider');
    mkdirSync(join(external, 'agents'), { recursive: true });
    writeFileSync(join(external, 'agents', 'web-agent.md'), '# Agent\n');
    symlinkSync(external, join(repo, '.claude'), 'dir');

    const diagnostics = [];
    const result = createStableReader(repo, diagnostics).read('.claude/agents/web-agent.md');
    assert.equal(result.text, '# Agent\n');
    assert.equal(result.label, '.claude/agents/web-agent.md');
    assert.equal(result.physicalPath, join(realpathSync.native(external), 'agents', 'web-agent.md'));
    assert.deepEqual(diagnostics, []);
  });
});

test('broken, cyclic, and non-directory mounts are controlled unsafe results, not absent hubs', () => {
  for (const kind of ['dangling', 'loop', 'file']) {
    withTemp(`broken-${kind}`, (base) => {
      const repo = repoWithHub(base, {});
      const target = join(base, 'target');
      if (kind === 'file') writeFileSync(target, '# Not a directory\n');
      symlinkSync(kind === 'loop' ? '.apex' : target, join(repo, '.apex'));
      assert.equal(bindApexRoot(realpathSync.native(repo)).state, 'unsafe', kind);

      const diagnostics = [];
      const reader = createStableReader(repo, diagnostics);
      assert.equal(reader.inspect('.apex', { kind: 'directory' }).state, 'unsafe', kind);
      assert.equal(reader.read('.apex/_INDEX.md').state, 'unsafe', kind);
      assert.match(messages(diagnostics), /^stable-read: \.apex/mu, kind);
    });
  }

  withTemp('broken-provider', (base) => {
    const repo = repoWithHub(base);
    symlinkSync(join(base, 'missing-provider'), join(repo, '.claude'), 'dir');
    const diagnostics = [];
    const result = createStableReader(repo, diagnostics).read('.claude/agents/web-agent.md');
    assert.equal(result.state, 'unsafe');
    assert.match(messages(diagnostics), /stable-read: \.claude\/agents\/web-agent\.md symlink mount could not be resolved safely/u);
  });
});

test('traversal that would erase an illicit component is refused before normalization', () => {
  withTemp('erase', (base) => {
    const sentinel = 'ERASED_COMPONENT_SENTINEL';
    const repo = repoWithHub(base, {
      '.apex/_INDEX.md': '# Index\n',
      '.apex/leaf.md': `# ${sentinel}\n`,
      '.apex/file.md': '# File\n',
      '.apex/work/draft.md': '# Draft\n',
      'outside/real/target.md': '# Target\n',
    });
    symlinkSync(join(repo, 'outside', 'real'), join(repo, '.apex', 'linked'), 'dir');

    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    for (const [path, physicalReason, reason] of [
      ['.apex/linked/../leaf.md', 'symlinked-ancestor', 'has symlinked component'],
      ['.apex/file.md/../leaf.md', 'non-directory-ancestor', 'has non-directory component'],
      ['.apex/work/../leaf.md', 'work-path', 'enters excluded .apex/work'],
      ['../leaf.md', 'outside-root', 'escapes the repository root'],
    ]) {
      const result = reader.read(path);
      assert.equal(result.state, 'unsafe', path);
      assert.equal(result.text, undefined, path);
      assert.equal(result.physicalReason, physicalReason, path);
      assert.match(messages(diagnostics), new RegExp(`stable-read: ${path.replaceAll('.', '\\.')} ${reason}`, 'u'));
    }
    assert.equal(reader.read(join(base, 'repo', '.apex', 'leaf.md')).state, 'unsafe');
    assert.match(messages(diagnostics), /escapes the repository root/u);
    assert.equal(reader.read('.apex/notes/../leaf.md').state, 'missing');
    assert.equal(reader.read('.apex/../.apex/leaf.md').text, `# ${sentinel}\n`);
    assert.equal(reader.read('.apex/linked', {}).state, 'unsafe');
    assert.match(messages(diagnostics), /stable-read: \.apex\/linked is symlink/u);
  });
});

test('a terminal separator or dot keeps its directory requirement', () => {
  withTemp('terminal', (base) => {
    const repo = repoWithHub(base, { '.apex/_INDEX.md': '# Index\n', 'ordinary.txt': 'file\n' });
    mkdirSync(join(repo, 'ordinary-dir'));
    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    for (const suffix of ['/', '/.']) {
      assert.equal(reader.inspect(`ordinary.txt${suffix}`, { kind: 'entry' }).physicalReason, 'non-directory-ancestor');
      assert.equal(reader.inspect(`ordinary-dir${suffix}`, { kind: 'entry' }).state, 'present');
    }
    assert.equal(diagnostics.length, 2, messages(diagnostics));
  });
});

test('reads are bounded, and a file grown past the bound since an earlier inspection is refused on re-inspection', () => {
  withTemp('bounded', (base) => {
    const repo = repoWithHub(base, {
      '.apex/_INDEX.md': '# Index\n',
      '.apex/exact.md': 'x'.repeat(MAX_STABLE_FILE_BYTES),
      '.apex/over.md': 'x'.repeat(MAX_STABLE_FILE_BYTES + 1),
      '.apex/growing.md': '# small\n',
    });
    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    assert.equal(MAX_STABLE_FILE_BYTES, 1024 * 1024);
    assert.equal(reader.read('.apex/exact.md').text.length, MAX_STABLE_FILE_BYTES);

    const over = reader.read('.apex/over.md');
    assert.equal(over.state, 'unsafe');
    assert.equal(over.text, undefined);

    assert.equal(reader.inspect('.apex/growing.md').state, 'present');
    appendFileSync(join(repo, '.apex', 'growing.md'), 'y'.repeat(MAX_STABLE_FILE_BYTES));
    const grown = reader.read('.apex/growing.md');
    assert.equal(grown.state, 'unsafe');
    assert.equal(grown.text, undefined);
    assert.match(messages(diagnostics), /stable-read: \.apex\/over\.md exceeds 1048576 bytes/u);
    assert.match(messages(diagnostics), /stable-read: \.apex\/growing\.md exceeds 1048576 bytes/u);
    assert.ok(diagnostics.every(({ msg }) => msg.length < 200), 'diagnostics carry no file bytes');
  });
});

test('a replaced hub or provider mount is a changed physical identity, and a retargeted link stays bound', () => {
  withTemp('identity', (base) => {
    const sentinel = 'REPLACED_IDENTITY_SENTINEL';
    const repo = repoWithHub(base);
    const provider = join(base, 'provider');
    mkdirSync(join(provider, 'agents'), { recursive: true });
    writeFileSync(join(provider, 'agents', 'a.md'), '# A\n');
    symlinkSync(provider, join(repo, '.claude'), 'dir');

    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    renameSync(join(repo, '.apex'), join(repo, 'old-apex'));
    mkdirSync(join(repo, '.apex'));
    writeFileSync(join(repo, '.apex', '_INDEX.md'), `# ${sentinel}\n`);
    renameSync(provider, join(base, 'old-provider'));
    mkdirSync(join(provider, 'agents'), { recursive: true });
    writeFileSync(join(provider, 'agents', 'a.md'), `# ${sentinel}\n`);

    for (const path of ['.apex/_INDEX.md', '.claude/agents/a.md']) {
      const result = reader.read(path);
      assert.equal(result.state, 'unsafe', path);
      assert.equal(result.text, undefined, path);
      assert.match(messages(diagnostics), new RegExp(`stable-read: ${path.replaceAll('.', '\\.')} changed physical identity`, 'u'));
    }
    assert.doesNotMatch(messages(diagnostics), new RegExp(sentinel, 'u'));
  });

  withTemp('retarget', (base) => {
    const repo = repoWithHub(base, {});
    for (const name of ['first', 'second']) {
      mkdirSync(join(base, name));
      writeFileSync(join(base, name, '_INDEX.md'), `# ${name}\n`);
    }
    symlinkSync(join(base, 'first'), join(repo, '.apex'), 'dir');
    const reader = createStableReader(repo, []);
    unlinkSync(join(repo, '.apex'));
    symlinkSync(join(base, 'second'), join(repo, '.apex'), 'dir');
    assert.equal(reader.read('.apex/_INDEX.md').text, '# first\n');
  });
});

test('the reserved work area is refused through direct, base-relative, and parent-relative spellings', () => {
  withTemp('work-name', (base) => {
    const sentinel = 'WORK_NAME_SENTINEL';
    const repo = repoWithHub(base, {
      '.apex/_INDEX.md': '# Index\n',
      '.apex/notes/leaf.md': '# Leaf\n',
      '.apex/work/specs/draft.md': `# ${sentinel}\n`,
    });
    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    for (const [path, options] of [
      ['.apex/work/specs/draft.md', {}],
      ['specs/draft.md', { base: '.apex/work' }],
      ['../work', { base: '.apex/notes', kind: 'directory' }],
    ]) {
      const result = options.kind ? reader.inspect(path, options) : reader.read(path, options);
      assert.equal(result.state, 'unsafe', path);
      assert.equal(result.physicalReason, 'work-path', path);
      assert.equal(result.localArea, 'work', path);
    }
    assert.match(messages(diagnostics), /stable-read: \.apex\/work\/specs\/draft\.md enters excluded \.apex\/work/u);
    assert.doesNotMatch(messages(diagnostics), new RegExp(sentinel, 'u'));

    const quiet = [];
    const silent = createStableReader(repo, quiet);
    assert.equal(silent.inspect('.apex/work', { kind: 'directory', reportUnsafe: false }).localArea, 'work');
    assert.deepEqual(quiet, []);
  });
});

// In these cases no bound physical identity exists for the area when the
// reader is constructed (absent, created later, or a link rather than an
// ordinary directory), so the logical name is the only defense.
function assertNameRefusal(result, diagnostics, area, label, sentinel) {
  assert.deepEqual(result, {
    state: 'unsafe',
    label,
    physicalReason: area.physicalReason,
    localArea: area.name,
    text: undefined,
  });
  assert.equal(messages(diagnostics), `stable-read: ${label} enters excluded ${area.path}`);
  if (sentinel) assert.doesNotMatch(messages(diagnostics), new RegExp(sentinel, 'u'));
}

test('every local area is excluded by name when it appears after the reader was constructed', () => {
  assert.ok(LOCAL_AREAS.length > 0);
  for (const area of LOCAL_AREAS) {
    withTemp(`late-${area.name}`, (base) => {
      const sentinel = `LATE_${area.name.toUpperCase()}_SENTINEL`;
      const repo = repoWithHub(base);
      const diagnostics = [];
      const reader = createStableReader(repo, diagnostics);
      mkdirSync(join(repo, ...area.path.split('/')), { recursive: true });
      writeFileSync(join(repo, ...area.path.split('/'), 'x.md'), `# ${sentinel}\n`);
      const label = `${area.path}/x.md`;
      assertNameRefusal(reader.read(label), diagnostics, area, label, sentinel);
    });
  }
});

test('every local area linked to an external directory is excluded by name, not as a symlinked component', () => {
  for (const area of LOCAL_AREAS) {
    withTemp(`linked-${area.name}`, (base) => {
      const sentinel = `LINKED_${area.name.toUpperCase()}_SENTINEL`;
      const repo = repoWithHub(base);
      const external = join(base, 'external');
      mkdirSync(external);
      writeFileSync(join(external, 'x.md'), `# ${sentinel}\n`);
      const segments = area.path.split('/');
      mkdirSync(join(repo, ...segments.slice(0, -1)), { recursive: true });
      symlinkSync(external, join(repo, ...segments), 'dir');
      const diagnostics = [];
      const label = `${area.path}/x.md`;
      assertNameRefusal(createStableReader(repo, diagnostics).read(label), diagnostics, area, label, sentinel);
    });
  }
});

test('every absent local area is refused by name rather than reported missing', () => {
  for (const area of LOCAL_AREAS) {
    withTemp(`absent-${area.name}`, (base) => {
      const repo = repoWithHub(base);
      const diagnostics = [];
      const result = createStableReader(repo, diagnostics).inspect(area.path, { kind: 'directory' });
      assertNameRefusal({ ...result, text: undefined }, diagnostics, area, area.path);
    });
  }
});

test('lexical local-area recognition normalizes components and never matches near names', () => {
  for (const [base, target] of [
    ['.apex', 'work/specs/draft.md'],
    ['.apex/notes', '../work'],
    ['', '.apex/work'],
    ['.apex/work', 'x.md'],
    ['.apex', './notes/../work/x.md'],
    ['.apex', 'work/../leaf.md'],
  ]) {
    assert.equal(rawPathEntersLocalArea(base, target)?.name, 'work', `${base} + ${target}`);
    assert.equal(rawPathEntersLocalArea(base, target)?.path, '.apex/work', `${base} + ${target}`);
  }
  for (const [base, target] of [
    ['.apex', 'workshop.md'],
    ['.apex', 'notes/work/x.md'],
    ['.apex', 'WORK/x.md'],
    ['', 'work/x.md'],
    ['.apex/notes', '../leaf.md'],
  ]) {
    assert.equal(rawPathEntersLocalArea(base, target), null, `${base} + ${target}`);
  }
});

test('a case alias of the reserved work area is excluded by physical identity', (t) => {
  withTemp('work-alias', (base) => {
    const sentinel = 'WORK_ALIAS_SENTINEL';
    const repo = repoWithHub(base, {
      '.apex/_INDEX.md': '# Index\n',
      '.apex/work/draft.md': `# ${sentinel}\n`,
    });
    if (!sameIdentity(join(repo, '.apex', 'work'), join(repo, '.apex', 'WORK'))) {
      t.skip('temporary storage keeps case-distinct directory identities');
      return;
    }
    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    for (const path of ['.apex/WORK/draft.md', '.apex/WoRk/draft.md']) {
      const result = reader.read(path);
      assert.equal(result.state, 'unsafe', path);
      assert.equal(result.localArea, 'work', path);
      assert.equal(result.text, undefined, path);
    }
    assert.match(messages(diagnostics), /stable-read: \.apex\/WORK\/draft\.md enters excluded \.apex\/work/u);
    assert.doesNotMatch(messages(diagnostics), new RegExp(sentinel, 'u'));
  });
});

test('a physically distinct case namesake of work remains stable content', (t) => {
  withTemp('work-distinct', (base) => {
    const repo = repoWithHub(base, { '.apex/_INDEX.md': '# Index\n', '.apex/work/draft.md': '# Draft\n' });
    mkdirSync(join(repo, '.apex', 'WORK'), { recursive: true });
    if (sameIdentity(join(repo, '.apex', 'work'), join(repo, '.apex', 'WORK'))) {
      t.skip('temporary storage aliases case spellings');
      return;
    }
    writeFileSync(join(repo, '.apex', 'WORK', 'visible.md'), '# Visible\n');
    const diagnostics = [];
    const result = createStableReader(repo, diagnostics).read('.apex/WORK/visible.md');
    assert.equal(result.state, 'present');
    assert.equal(result.text, '# Visible\n');
    assert.equal(result.localArea, undefined);
    assert.deepEqual(diagnostics, []);
  });
});

test('non-file candidates are refused without blocking', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, () => {
  withTemp('fifo', (base) => {
    const repo = repoWithHub(base);
    const fifo = spawnSync('mkfifo', [join(repo, '.apex', 'pipe.md')], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
    const diagnostics = [];
    const result = createStableReader(repo, diagnostics).read('.apex/pipe.md');
    assert.equal(result.state, 'unsafe');
    assert.equal(result.physicalReason, 'non-file');
    assert.match(messages(diagnostics), /stable-read: \.apex\/pipe\.md is non-file/u);
  });
});

test('diagnostics are deduplicated, suppressible, and collected without writing', () => {
  withTemp('collect', (base) => {
    const repo = repoWithHub(base, { '.apex/_INDEX.md': '# Index\n', '.apex/work/draft.md': '# Draft\n' });
    symlinkSync(join(repo, '.apex', '_INDEX.md'), join(repo, '.apex', 'alias.md'));
    const before = treeSnapshot(base);

    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    assert.equal(reader.read('.apex/alias.md').state, 'unsafe');
    assert.equal(reader.read('.apex/alias.md').state, 'unsafe');
    assert.equal(reader.read('.apex/work/draft.md', { reportUnsafe: false }).state, 'unsafe');
    reader.report('custom label', 'is custom');
    reader.report('custom label', 'is custom');

    assert.deepEqual(diagnostics, [
      { level: 'error', msg: 'stable-read: .apex/alias.md is symlink' },
      { level: 'error', msg: 'stable-read: custom label is custom' },
    ]);
    assert.equal(reader.diagnostics, diagnostics);
    assert.deepEqual(treeSnapshot(base), before);
    assert.equal(existsSync(join(repo, '.apex', 'work', 'draft.md')), true);
  });
});

// Records every body-read or enumeration attempt made while `fn` runs; the
// wrapped built-ins still perform the real operation unless `before` throws.
function recordFsAccess(fn, before = () => {}) {
  const names = ['openSync', 'readFileSync', 'readdirSync', 'opendirSync'];
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  const accesses = [];
  try {
    for (const name of names) {
      fs[name] = function recorded(...args) {
        accesses.push({ name, path: String(args[0]) });
        before(name, args);
        return originals[name].apply(this, args);
      };
    }
    syncBuiltinESMExports();
    return { result: fn(), accesses };
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

function under(path, directory) {
  const candidate = path.toLowerCase();
  const prefix = directory.toLowerCase();
  return candidate === prefix || candidate.startsWith(`${prefix}${sep}`);
}

const RUN = '0b6f1b8e-3c1a-4e2b-9f3d-5a7c9e1b2d4f';

test('the reader registry covers work and inception, derived from the shared sanitize registry', () => {
  assert.deepEqual(LOCAL_AREAS.map(({ name }) => name), [...LOCAL_AREA_NAMES]);
  assert.deepEqual(LOCAL_AREAS.map((area) => ({ ...area })), [
    { name: 'work', path: '.apex/work', physicalReason: 'work-path' },
    { name: 'inception', path: '.apex/inception', physicalReason: 'inception-path' },
  ]);
});

test('lexical inception recognition refuses entering and enter-then-exit spellings, never near names', () => {
  for (const [base, target] of [
    ['.apex', 'inception/state.json'],
    ['.apex/notes', '../inception'],
    ['', '.apex/inception'],
    ['.apex', `inception/${RUN}/proposal.md`],
    ['.apex', 'inception/../leaf.md'],
    ['.apex/standards', '../inception/../standards/web.md'],
  ]) {
    assert.equal(rawPathEntersLocalArea(base, target)?.name, 'inception', `${base} + ${target}`);
    assert.equal(rawPathEntersLocalArea(base, target)?.path, '.apex/inception', `${base} + ${target}`);
  }
  for (const [base, target] of [
    ['.apex', 'inceptions.md'],
    ['.apex', 'notes/inception/x.md'],
    ['.apex', 'INCEPTION/x.md'],
    ['', 'inception/x.md'],
  ]) {
    assert.equal(rawPathEntersLocalArea(base, target), null, `${base} + ${target}`);
  }
});

test('the inception area is refused through direct, base-relative, parent-relative, and traversal spellings without opening it', () => {
  withTemp('inception-name', (base) => {
    const sentinel = 'INCEPTION_NAME_SENTINEL';
    const repo = repoWithHub(base, {
      '.apex/_INDEX.md': '# Index\n',
      '.apex/leaf.md': '# Leaf\n',
      '.apex/notes/leaf.md': '# Leaf\n',
      [`.apex/inception/${RUN}/proposal.md`]: `# ${sentinel}\n`,
      '.apex/inception/state.json': `{"${sentinel}":true}\n`,
    });
    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    const { accesses } = recordFsAccess(() => {
      for (const [path, options] of [
        [`.apex/inception/${RUN}/proposal.md`, {}],
        ['.apex/inception/state.json', {}],
        ['state.json', { base: '.apex/inception' }],
        ['../inception', { base: '.apex/notes', kind: 'directory' }],
        ['.apex/inception/../leaf.md', {}],
      ]) {
        const result = options.kind ? reader.inspect(path, options) : reader.read(path, options);
        assert.equal(result.state, 'unsafe', path);
        assert.equal(result.physicalReason, 'inception-path', path);
        assert.equal(result.localArea, 'inception', path);
        assert.equal(result.text, undefined, path);
      }
    });
    assert.deepEqual(accesses, []);
    assert.match(messages(diagnostics), /stable-read: \.apex\/inception\/state\.json enters excluded \.apex\/inception/u);
    assert.doesNotMatch(messages(diagnostics), new RegExp(sentinel, 'u'));
  });
});

test('a stable file with more than one hard link is refused before any body read, without enumerating local areas', () => {
  withTemp('hardlink', (base) => {
    const sentinel = 'HARDLINKED_INCEPTION_BODY_SENTINEL';
    const repo = repoWithHub(base, {
      '.apex/_INDEX.md': '# Index\n',
      [`.apex/inception/${RUN}/proposal.md`]: `# ${sentinel}\n`,
    });
    mkdirSync(join(repo, '.apex', 'standards'));
    linkSync(join(repo, '.apex', 'inception', RUN, 'proposal.md'), join(repo, '.apex', 'standards', 'web.md'));
    linkSync(join(repo, '.apex', '_INDEX.md'), join(base, 'outside-index.md'));

    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    const { result, accesses } = recordFsAccess(() => [
      reader.read('.apex/standards/web.md'),
      reader.read('.apex/_INDEX.md'),
      reader.inspect('.apex/standards/web.md'),
      reader.inspect('.apex/standards/web.md', { kind: 'entry' }),
    ]);
    const [standard, index, admission, entry] = result;
    for (const [label, refused] of [['standard', standard], ['index', index], ['admission', admission]]) {
      assert.equal(refused.state, 'unsafe', label);
      assert.equal(refused.physicalReason, 'hardlink', label);
      assert.equal(refused.text, undefined, label);
    }
    assert.equal(entry.state, 'present', 'existence-only admission is not a body read');
    assert.deepEqual(accesses, [], 'refusal happens on metadata before any open or enumeration');
    assert.match(messages(diagnostics), /stable-read: \.apex\/standards\/web\.md is hard-linked/u);
    assert.match(messages(diagnostics), /stable-read: \.apex\/_INDEX\.md is hard-linked/u);
    assert.doesNotMatch(messages(diagnostics), new RegExp(sentinel, 'u'));
  });
});

test('a hard link created between admission and open is refused by the opened descriptor', () => {
  withTemp('hardlink-race', (base) => {
    const sentinel = 'RACED_HARDLINK_SENTINEL';
    const repo = repoWithHub(base, { '.apex/_INDEX.md': `# ${sentinel}\n` });
    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    let linked = false;
    const { result } = recordFsAccess(() => reader.read('.apex/_INDEX.md'), (name, args) => {
      if (name === 'openSync' && !linked && String(args[0]).endsWith('_INDEX.md')) {
        linked = true;
        linkSync(args[0], join(base, 'late-link.md'));
      }
    });
    assert.equal(linked, true);
    assert.equal(result.state, 'unsafe');
    assert.equal(result.text, undefined);
    assert.match(messages(diagnostics), /stable-read: \.apex\/_INDEX\.md changed physical identity during open/u);
    assert.doesNotMatch(messages(diagnostics), new RegExp(sentinel, 'u'));
  });
});

test('a project mount into a local area is a symlink refusal that names the area', () => {
  for (const area of LOCAL_AREAS) {
    withTemp(`mount-into-${area.name}`, (base) => {
      const sentinel = `MOUNT_INTO_${area.name.toUpperCase()}_SENTINEL`;
      const repo = repoWithHub(base, { [`${area.path}/agents/x.md`]: `# ${sentinel}\n` });
      symlinkSync(area.path, join(repo, '.claude'), 'dir');
      const diagnostics = [];
      const { result, accesses } = recordFsAccess(() => createStableReader(repo, diagnostics).read('.claude/agents/x.md'));
      assert.equal(result.state, 'unsafe');
      assert.equal(result.localArea, area.name);
      assert.equal(result.physicalReason, 'symlink', 'a refused mount keeps its symlink reason');
      assert.deepEqual(accesses, []);
      assert.equal(messages(diagnostics), `stable-read: .claude/agents/x.md symlink mount enters excluded ${area.path}`);
    });
  }
});

test('the physical target of a linked local area is excluded when reached through another mount', () => {
  for (const area of LOCAL_AREAS) {
    withTemp(`linked-target-${area.name}`, (base) => {
      const sentinel = `LINKED_TARGET_${area.name.toUpperCase()}_SENTINEL`;
      const repo = repoWithHub(base);
      const provider = join(base, 'provider');
      mkdirSync(join(provider, 'area'), { recursive: true });
      writeFileSync(join(provider, 'area', 'x.md'), `# ${sentinel}\n`);
      symlinkSync(join(provider, 'area'), join(repo, ...area.path.split('/')), 'dir');
      symlinkSync(provider, join(repo, '.claude'), 'dir');
      const diagnostics = [];
      const { result, accesses } = recordFsAccess(() => createStableReader(repo, diagnostics).read('.claude/area/x.md'));
      assert.equal(result.state, 'unsafe');
      assert.equal(result.localArea, area.name);
      assert.equal(result.text, undefined);
      assert.deepEqual(accesses, []);
      assert.equal(messages(diagnostics), `stable-read: .claude/area/x.md aliases excluded ${area.path}`);
    });
  }
});

test('a case alias of the inception area is excluded by physical identity', (t) => {
  withTemp('inception-alias', (base) => {
    const sentinel = 'INCEPTION_ALIAS_SENTINEL';
    const repo = repoWithHub(base, { '.apex/_INDEX.md': '# Index\n', '.apex/inception/state.json': `${sentinel}\n` });
    if (!sameIdentity(join(repo, '.apex', 'inception'), join(repo, '.apex', 'INCEPTION'))) {
      t.skip('temporary storage keeps case-distinct directory identities');
      return;
    }
    const diagnostics = [];
    const reader = createStableReader(repo, diagnostics);
    const { accesses } = recordFsAccess(() => {
      for (const path of ['.apex/INCEPTION/state.json', '.apex/InCePtIoN/../_INDEX.md']) {
        const result = reader.read(path);
        assert.equal(result.state, 'unsafe', path);
        assert.equal(result.localArea, 'inception', path);
      }
    });
    assert.deepEqual(accesses, []);
    assert.doesNotMatch(messages(diagnostics), new RegExp(sentinel, 'u'));
  });
});

test('controllers read one stable document through a throwing convenience with the same admission', () => {
  withTemp('document', (base) => {
    const repo = repoWithHub(base, {
      '.apex/_INDEX.md': '# Index\n',
      [`.apex/inception/${RUN}/plan.md`]: '# DOCUMENT_LOCAL_SENTINEL\n',
    });
    assert.equal(readStableDocument(repo, '.apex/_INDEX.md', 'routing index'), '# Index\n');
    linkSync(join(repo, '.apex', '_INDEX.md'), join(base, 'second-name.md'));
    for (const [path, reason] of [
      ['.apex/_INDEX.md', /routing index cannot be read as a stable document: stable-read: \.apex\/_INDEX\.md is hard-linked/u],
      [`.apex/inception/${RUN}/plan.md`, /enters excluded \.apex\/inception/u],
      ['.apex/absent.md', /routing index cannot be read as a stable document: is missing/u],
    ]) {
      assert.throws(() => readStableDocument(repo, path, 'routing index'), (error) => {
        assert.match(error.message, reason, path);
        assert.doesNotMatch(error.message, /DOCUMENT_LOCAL_SENTINEL/u, path);
        assert.equal(error.code, 'STABLE_READ', path);
        return true;
      }, path);
    }
  });
});

test('only the literal local-area entries are local-area entries; a linked target alias is a loud refusal', () => {
  for (const area of LOCAL_AREAS) {
    withTemp(`literal-${area.name}`, (base) => {
      const repo = repoWithHub(base, { '.apex/_INDEX.md': '# Index\n', '.apex/sub/orphan.md': '# ALIAS_SENTINEL\n' });
      symlinkSync('sub', join(repo, ...area.path.split('/')), 'dir');
      const diagnostics = [];
      const reader = createStableReader(repo, diagnostics);
      assert.equal(reader.isLocalAreaEntry(area.path), true, area.name);
      assert.equal(reader.isLocalAreaEntry('.apex/sub'), false, area.name);
      assert.equal(reader.isLocalAreaEntry(`.apex/notes/${area.name}`), false, area.name);
      assert.equal(reader.isLocalAreaEntry('.apex'), false, area.name);
      assert.deepEqual(diagnostics, []);
      const { result, accesses } = recordFsAccess(() => reader.inspect('.apex/sub', { kind: 'directory' }));
      assert.equal(result.state, 'unsafe');
      assert.equal(result.localArea, area.name);
      assert.deepEqual(accesses, []);
      assert.equal(messages(diagnostics), `stable-read: .apex/sub aliases excluded ${area.path}`);
    });
  }
});

test('a stored case alias of a literal local-area entry is still that entry', (t) => {
  withTemp('literal-case', (base) => {
    const repo = repoWithHub(base);
    mkdirSync(join(repo, '.apex', 'INCEPTION'));
    if (!sameIdentity(join(repo, '.apex', 'inception'), join(repo, '.apex', 'INCEPTION'))) {
      t.skip('temporary storage keeps case-distinct directory identities');
      return;
    }
    const reader = createStableReader(repo, []);
    assert.equal(reader.isLocalAreaEntry('.apex/INCEPTION'), true);
    assert.equal(reader.isLocalAreaEntry('.apex/InCePtIoN'), true);
  });
});


test('exact file localization is metadata-only and binds present files and prospective mounted destinations', () => {
  for (const absolute of [false, true]) withTemp(`locate-${absolute}`, (base) => {
    const repo = repoWithHub(base, { 'hub/standards/web.md': '# Web\n' });
    symlinkSync(absolute ? join(repo, 'hub') : 'hub', join(repo, '.apex'), 'dir');
    const reader = createStableReader(repo);
    const before = treeSnapshot(base);
    const { result, accesses } = recordFsAccess(() => [
      reader.locateFile('.apex/standards/web.md'), reader.locateFile('hub/standards/web.md'),
      reader.locateFile('.apex/standards/new/deep.md'), reader.locateFile('hub/standards/new/deep.md'),
    ]);
    const [mounted, direct, absentMounted, absentDirect] = result;
    assert.equal(mounted.state, 'present');
    assert.equal(mounted.physicalPath, realpathSync.native(join(repo, 'hub/standards/web.md')));
    assert.equal(mounted.dev, direct.dev);
    assert.equal(mounted.ino, direct.ino);
    assert.equal(absentMounted.state, 'missing');
    assert.deepEqual(absentMounted, absentDirect);
    assert.equal(absentMounted.suffix, join('new', 'deep.md'));
    assert.equal(absentMounted.ancestor.physicalPath, realpathSync.native(join(repo, 'hub/standards')));
    assert.equal(absentMounted.ancestor.ino, lstatSync(join(repo, 'hub/standards'), { bigint: true }).ino);
    assert.equal(absentMounted.physicalPath, join(realpathSync.native(repo), 'hub/standards/new/deep.md'));
    assert.deepEqual(accesses, []);
    assert.deepEqual(treeSnapshot(base), before);
  });
});

test('exact file localization validates the entire lexical path before returning absence', () => withTemp('locate-lexical', (base) => {
  const repo = repoWithHub(base, {});
  const reader = createStableReader(repo);
  const { accesses } = recordFsAccess(() => {
    for (const path of ['missing/../file.md', 'missing/../../file.md', 'missing//file.md', 'missing/./file.md',
      'missing/file.md/', '.apex/work/file.md', '.apex/inception/file.md', 'missing/../.apex/inception/file.md']) {
      assert.equal(reader.locateFile(path).state, 'unsafe', path);
    }
    assert.equal(reader.locateFile('.apex/standards/web.md').state, 'missing');
    assert.equal(createStableReader(join(base, 'absent-root')).locateFile('missing/../file.md').state, 'unsafe',
      'an absent repository must not bypass complete lexical validation');
    assert.deepEqual(reader.inspect('missing/../file.md'), { state: 'missing', label: 'missing/../file.md' },
      'existing inspect results retain their contract');
  });
  assert.deepEqual(accesses, []);
}));

test('exact file localization retains physical local-area, link, mount, and root admission without opening files', () => withTemp('locate-unsafe', (base) => {
  const repo = repoWithHub(base, { 'shared/local.md': '# Private\n', '.apex/work/draft.md': '# Work\n',
    '.apex/standards/web.md': '# Web\n' });
  symlinkSync(join(repo, 'shared'), join(repo, '.apex/inception'), 'dir');
  symlinkSync('standards', join(repo, '.apex/alias'), 'dir');
  linkSync(join(repo, '.apex/work/draft.md'), join(repo, 'hardlink.md'));
  symlinkSync('absent-provider', join(repo, '.claude'), 'dir');
  symlinkSync(repo, join(base, 'root-alias'), 'dir');
  const before = treeSnapshot(base);
  const { accesses } = recordFsAccess(() => {
    const reader = createStableReader(repo);
    for (const path of ['shared/local.md', 'shared/missing.md', 'hardlink.md', '.apex/alias/new.md',
      '.claude/agents/new.md', '.apex/standards/web.md/new.md', '.apex/standards']) {
      assert.equal(reader.locateFile(path).state, 'unsafe', path);
    }
    assert.equal(createStableReader(join(base, 'root-alias')).locateFile('new.md').state, 'unsafe');
  });
  assert.deepEqual(accesses, []);
  assert.deepEqual(treeSnapshot(base), before);
}));
