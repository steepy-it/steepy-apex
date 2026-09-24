import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
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
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  MAX_STABLE_FILE_BYTES,
  admitHubRoot,
  bindApexRoot,
  createStableReader,
  rawPathEntersLocalArea,
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

test('reads are bounded, including a file that grows past the bound after inspection', () => {
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

test('the reserved work area is excluded by name before any byte is read', () => {
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
