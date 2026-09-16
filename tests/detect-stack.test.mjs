import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectStack } from '../scripts/detect-stack.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function withTempPnpmWorkspace(workspace, callback) {
  const root = mkdtempSync(join(tmpdir(), 'detect-stack-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"root"}\n');
    writeFileSync(join(root, 'pnpm-workspace.yaml'), workspace);
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'package.json'), '{"name":"web"}\n');
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeTempPackage(root, path, name = path.split('/').pop()) {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, 'package.json'), JSON.stringify({ name }));
}

function assertInconclusive(result) {
  assert.equal(result.inconclusive, true);
  assert.equal(result.monorepo, false);
  assert.deepEqual(result.surfaces, []);
}

test('pnpm monorepo: detects two surfaces with their commands', () => {
  const r = detectStack(join(here, 'fixtures', 'pnpm-mono'));
  assert.equal(r.packageManager, 'pnpm');
  assert.equal(r.monorepo, true);
  const names = r.surfaces.map((s) => s.name).sort();
  assert.deepEqual(names, ['core', 'web']);
  const web = r.surfaces.find((s) => s.name === 'web');
  assert.equal(web.test, 'vitest');
  assert.equal(web.lint, 'biome check');
  assert.equal(web.path, 'apps/web');
});

test('pnpm "packages/**" recursive glob: detects nested surfaces', () => {
  const r = detectStack(join(here, 'fixtures', 'pnpm-recursive'));
  assert.equal(r.packageManager, 'pnpm');
  assert.equal(r.monorepo, true);
  const names = r.surfaces.map((s) => s.name).sort();
  assert.deepEqual(names, ['api', 'ui']);
  const api = r.surfaces.find((s) => s.name === 'api');
  assert.equal(api.path, 'packages/group/api');
  assert.equal(api.test, 'jest');
});

test('pnpm flow package lists accept quoted values and trailing comments', () => {
  withTempPnpmWorkspace("packages: [ 'apps/*' ] # workspace packages\n", (root) => {
    const result = detectStack(root);
    assert.equal(result.inconclusive, false);
    assert.equal(result.monorepo, true);
    assert.deepEqual(result.surfaces.map((surface) => surface.name), ['web']);
  });
});

test('pnpm malformed and unsupported package syntax is inconclusive without root fallback', () => {
  for (const workspace of [
    "packages: [ 'apps/*' # missing flow-list close\n",
    "packages:\n  - 'apps/*\n",
    "packages:\n  - 'apps/*'\n  - '!**/__tests__/**'\n",
    "packages: [ 'apps/*/*' ]\n",
  ]) {
    withTempPnpmWorkspace(workspace, (root) => {
      const result = detectStack(root);
      assert.equal(result.inconclusive, true);
      assert.equal(result.monorepo, false);
      assert.deepEqual(result.surfaces, []);
    });
  }
});

test('pnpm duplicate and unsupported package-list structure is inconclusive', () => {
  for (const workspace of [
    "packages: [ 'apps/*' ]\npackages: [ 'apps/*' ]\n",
    "packages: [ 'apps/*' ]\nignored: true\npackages: [ 'apps/*' ]\n",
    "packages:\n\t- 'apps/*'\n",
    "packages:\n- 'apps/*'\n",
  ]) {
    withTempPnpmWorkspace(workspace, (root) => {
      const result = detectStack(root);
      assert.equal(result.inconclusive, true);
      assert.equal(result.monorepo, false);
      assert.deepEqual(result.surfaces, []);
    });
  }
});

test('pnpm block-list indentation must stay consistent and flat', () => {
  for (const workspace of [
    "packages:\n  - apps/*\n    - libs/*\n",
    "packages:\n  - apps/*\n   - libs/*\n",
  ]) {
    withTempPnpmWorkspace(workspace, (root) => {
      const result = detectStack(root);
      assert.equal(result.inconclusive, true);
      assert.equal(result.monorepo, false);
      assert.deepEqual(result.surfaces, []);
    });
  }

  withTempPnpmWorkspace("packages:\n    - 'apps/*' # a quoted comment-safe value\n    - \"libs/*\"\n", (root) => {
    const result = detectStack(root);
    assert.equal(result.inconclusive, false);
    assert.equal(result.monorepo, true);
    assert.deepEqual(result.surfaces.map((surface) => surface.name), ['web']);
  });
});

test('pnpm flow declarations reject list continuations but preserve empty and absent inputs', () => {
  for (const workspace of [
    'packages: []\n- apps/*\n',
    'packages: [apps/*]\n\t- libs/*\n',
  ]) {
    withTempPnpmWorkspace(workspace, (root) => {
      const result = detectStack(root);
      assert.equal(result.inconclusive, true);
      assert.equal(result.monorepo, false);
      assert.deepEqual(result.surfaces, []);
    });
  }

  for (const workspace of ['packages: []\n', 'catalog: {}\n']) {
    withTempPnpmWorkspace(workspace, (root) => {
      const result = detectStack(root);
      assert.equal(result.inconclusive, false);
      assert.equal(result.monorepo, false);
      assert.deepEqual(result.surfaces.map((surface) => surface.name), ['root']);
    });
  }
});

test('pnpm mapping-shaped package items are inconclusive while simple scalars remain valid', () => {
  for (const workspace of [
    'packages:\n  - path: apps/*\n',
    'packages: [path: apps/*]\n',
  ]) {
    withTempPnpmWorkspace(workspace, (root) => {
      const result = detectStack(root);
      assert.equal(result.inconclusive, true);
      assert.equal(result.monorepo, false);
      assert.deepEqual(result.surfaces, []);
    });
  }

  withTempPnpmWorkspace("packages:\n  - apps/* # ordinary\n  - 'libs/*'\n  - \"tools/*\"\n", (root) => {
    const result = detectStack(root);
    assert.equal(result.inconclusive, false);
    assert.equal(result.monorepo, true);
    assert.deepEqual(result.surfaces.map((surface) => surface.name), ['web']);
  });
});

test('pnpm unsupported packages-key spellings are inconclusive', () => {
  for (const workspace of [
    'packages : [apps/*]\n',
    'packages :\n  - apps/*\n',
    '"packages": [apps/*]\n',
    "'packages':\n  - apps/*\n",
  ]) {
    withTempPnpmWorkspace(workspace, (root) => {
      const result = detectStack(root);
      assert.equal(result.inconclusive, true);
      assert.equal(result.monorepo, false);
      assert.deepEqual(result.surfaces, []);
    });
  }

  for (const workspace of ['packages: []\n', 'packages:\n', 'catalog: {}\n']) {
    withTempPnpmWorkspace(workspace, (root) => {
      const result = detectStack(root);
      assert.equal(result.inconclusive, false);
      assert.equal(result.monorepo, false);
      assert.deepEqual(result.surfaces.map((surface) => surface.name), ['root']);
    });
  }
});

test('pnpm unsupported scalar syntax is inconclusive in block and flow lists', () => {
  for (const scalar of ['&web apps/*', '!path apps/*', '"apps\\\\/*"', 'true', '42', 'null']) {
    for (const workspace of [
      `packages:\n  - ${scalar}\n`,
      `packages: [${scalar}]\n`,
    ]) {
      withTempPnpmWorkspace(workspace, (root) => {
        const result = detectStack(root);
        assert.equal(result.inconclusive, true);
        assert.equal(result.monorepo, false);
        assert.deepEqual(result.surfaces, []);
      });
    }
  }

  withTempPnpmWorkspace("packages:\n  - apps/web # ordinary literal\n  - 'apps/*'\n  - \"packages/**\"\n", (root) => {
    const result = detectStack(root);
    assert.equal(result.inconclusive, false);
    assert.equal(result.monorepo, true);
    assert.deepEqual(result.surfaces.map((surface) => surface.name), ['web', 'web']);
  });
});

test('pnpm empty and Core-typed path values are inconclusive in block and flow lists', () => {
  for (const scalar of ["''", '""', "'  '", '" \\t"', '0x10', '0o10', '1.25', '1e3', '.inf', '.nan']) {
    for (const workspace of [
      `packages:\n  - ${scalar}\n`,
      `packages: [${scalar}]\n`,
    ]) {
      withTempPnpmWorkspace(workspace, (root) => {
        const result = detectStack(root);
        assert.equal(result.inconclusive, true);
        assert.equal(result.monorepo, false);
        assert.deepEqual(result.surfaces, []);
      });
    }
  }

  withTempPnpmWorkspace('packages: ["0x10"]\n', (root) => {
    const result = detectStack(root);
    assert.equal(result.inconclusive, false);
    assert.equal(result.monorepo, true);
    assert.deepEqual(result.surfaces, []);
  });
});

test('pnpm indented packages declarations are inconclusive', () => {
  for (const workspace of [
    ' packages: [apps/*]\n',
    '\tpackages:\n\t  - apps/*\n',
  ]) {
    withTempPnpmWorkspace(workspace, (root) => {
      const result = detectStack(root);
      assert.equal(result.inconclusive, true);
      assert.equal(result.monorepo, false);
      assert.deepEqual(result.surfaces, []);
    });
  }
});

test('pnpm comments preserve adjacent hash path bytes and require token separation', () => {
  for (const workspace of [
    'packages:\n  - apps/web#alternate\n',
    'packages: [apps/web#alternate]\n',
    'packages:\n  - "apps/web#alternate"\n',
  ]) {
    withTempPnpmWorkspace(workspace, (root) => {
      writeTempPackage(root, 'apps/web#alternate', 'hash-path');
      const result = detectStack(root);
      assert.equal(result.inconclusive, false);
      assert.deepEqual(result.surfaces.map((surface) => surface.path), ['apps/web#alternate']);
    });
  }

  withTempPnpmWorkspace('packages:\n  - apps/web # ordinary comment\n', (root) => {
    assert.deepEqual(detectStack(root).surfaces.map((surface) => surface.path), ['apps/web']);
  });

  for (const workspace of [
    'packages:\n  - "apps/web"#not-a-comment\n',
    'packages: ["apps/web"#not-a-comment]\n',
  ]) {
    withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
  }
});

test('pnpm rejects non-path node representations before glob expansion', () => {
  for (const workspace of [
    'packages:\n  - |\n',
    'packages: [>]\n',
    'packages:\n  - apps/web:\n',
    'packages: [apps/web:]\n',
    'packages:\n  - - apps/web\n',
    'packages: [- apps/web]\n',
  ]) {
    withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
  }

  withTempPnpmWorkspace('packages: ["apps/web:"]\n', (root) => {
    writeTempPackage(root, 'apps/web:', 'punctuation');
    assert.deepEqual(detectStack(root).surfaces.map((surface) => surface.path), ['apps/web:']);
  });
});

test('pnpm Core lexical values are typed only at exact spellings', () => {
  for (const scalar of ['1.', '1.e3']) {
    for (const workspace of [`packages:\n  - ${scalar}\n`, `packages: [${scalar}]\n`]) {
      withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
    }
  }

  withTempPnpmWorkspace('packages: [1_0, tRuE, "1."]\n', (root) => {
    writeTempPackage(root, '1_0');
    writeTempPackage(root, 'tRuE');
    writeTempPackage(root, '1.');
    const result = detectStack(root);
    assert.equal(result.inconclusive, false);
    assert.deepEqual(result.surfaces.map((surface) => surface.path).sort(), ['1.', '1_0', 'tRuE']);
  });
});

test('pnpm unsupported outer document forms and non-key transitions are inconclusive', () => {
  for (const workspace of [
    '? packages\n: [apps/*]\n',
    '{packages: [apps/*]}\n',
    'packages: []\nbare garbage\n  - apps/*\n',
    'packages: []\n---\n- apps/*\n',
    'packages:[apps/*]\n',
  ]) {
    withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
  }
});

test('pnpm unrelated mapping bodies remain opaque before and after packages', () => {
  const catalog = "catalog:\n  packages: 1.0.0\n  library: git+https://example.com/owner/o'hare\n";
  withTempPnpmWorkspace(catalog, (root) => {
    const result = detectStack(root);
    assert.equal(result.inconclusive, false);
    assert.deepEqual(result.surfaces.map((surface) => surface.name), ['root']);
  });
  withTempPnpmWorkspace(`packages: [apps/*]\n${catalog}`, (root) => {
    const result = detectStack(root);
    assert.equal(result.inconclusive, false);
    assert.deepEqual(result.surfaces.map((surface) => surface.path), ['apps/web']);
  });
});

test('pnpm extended glob operators make the whole pattern set inconclusive', () => {
  for (const workspace of [
    'packages:\n  - apps/@(web)\n',
    'packages: [apps/+(web)]\n',
    'packages: [apps/!(web)]\n',
    'packages: [apps/*, apps/@(web)]\n',
  ]) {
    withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
  }

  withTempPnpmWorkspace('packages: [apps/web, apps/*]\n', (root) => {
    const result = detectStack(root);
    assert.equal(result.inconclusive, false);
    assert.deepEqual(result.surfaces.map((surface) => surface.path), ['apps/web', 'apps/web']);
  });
});

test('pnpm bare indicator nodes are inconclusive while quoted indicator paths remain strings', () => {
  for (const scalar of ['-', '%path']) {
    for (const workspace of [
      `packages:\n  - ${scalar}\n`,
      `packages: [${scalar}]\n`,
      `packages: [apps/*, ${scalar}]\n`,
    ]) {
      withTempPnpmWorkspace(workspace, (root) => {
        writeTempPackage(root, scalar, `indicator-${scalar}`);
        assertInconclusive(detectStack(root));
      });
    }

    for (const workspace of [
      `packages:\n  - "${scalar}"\n`,
      `packages: ["${scalar}"]\n`,
    ]) {
      withTempPnpmWorkspace(workspace, (root) => {
        writeTempPackage(root, scalar, `quoted-${scalar}`);
        assert.deepEqual(detectStack(root).surfaces.map((surface) => surface.path), [scalar]);
      });
    }
  }
});

test('pnpm Core numeric signs leave octal and hexadecimal lookalikes as strings', () => {
  for (const scalar of ['+0x10', '-0o10']) {
    for (const workspace of [
      `packages:\n  - ${scalar}\n`,
      `packages: [${scalar}]\n`,
    ]) {
      withTempPnpmWorkspace(workspace, (root) => {
        writeTempPackage(root, scalar);
        assert.deepEqual(detectStack(root).surfaces.map((surface) => surface.path), [scalar]);
      });
    }
  }

  for (const scalar of ['0x10', '0o10', '+10']) {
    for (const workspace of [`packages:\n  - ${scalar}\n`, `packages: [${scalar}]\n`]) {
      withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
    }
  }
});

test('pnpm leading hash flow nodes are inconclusive while quoted hashes remain paths', () => {
  for (const workspace of ['packages: [#foo]\n', 'packages: [apps/*,#foo]\n']) {
    withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
  }

  withTempPnpmWorkspace('packages: ["#foo"]\n', (root) => {
    writeTempPackage(root, '#foo');
    assert.deepEqual(detectStack(root).surfaces.map((surface) => surface.path), ['#foo']);
  });
});

test('pnpm package tokens preserve NBSP bytes and use only ASCII space or tab separators', () => {
  const nbspPath = 'apps/web\u00a0';
  const nbspHashPath = 'apps/web\u00a0#alternate';
  for (const workspace of [
    `packages: [${nbspPath}]\n`,
    `packages:\n  - ${nbspHashPath}\n`,
    `packages: ["${nbspPath}"]\n`,
  ]) {
    withTempPnpmWorkspace(workspace, (root) => {
      writeTempPackage(root, nbspPath, 'nbsp');
      writeTempPackage(root, nbspHashPath, 'nbsp-hash');
      const result = detectStack(root);
      assert.equal(result.inconclusive, false);
      assert.ok(result.surfaces.some((surface) => surface.path === (workspace.includes('#alternate') ? nbspHashPath : nbspPath)));
    });
  }

  for (const workspace of ['packages: [apps/web] # comment\n', 'packages:\n  - apps/web\t# comment\n', 'packages: [apps/web]\r\n']) {
    withTempPnpmWorkspace(workspace, (root) => assert.deepEqual(detectStack(root).surfaces.map((surface) => surface.path), ['apps/web']));
  }
});

test('pnpm forbidden raw controls are inconclusive in plain and quoted scalar styles', () => {
  for (const scalar of ['apps/we\u0000b', "'apps/we\u0000b'", '"apps/we\u0000b"', 'apps/we\u0001b']) {
    for (const workspace of [`packages:\n  - ${scalar}\n`, `packages: [${scalar}]\n`, `packages: [apps/*, ${scalar}]\n`]) {
      withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
    }
  }
});

test('pnpm rejects every supported-text forbidden range before package comments are dropped', () => {
  for (const scalar of [
    'apps/we\u0080b',
    "'apps/we\u0084b'",
    '"apps/we\u0086b"',
    'apps/we\u009fb',
    'apps/we\ufffeb',
    "'apps/we\uffffb'",
  ]) {
    for (const workspace of [
      `packages:\n  - ${scalar}\n`,
      `packages: [${scalar}]\n`,
      `packages: [apps/*, ${scalar}]\n`,
    ]) {
      withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
    }
  }

  for (const workspace of [
    'packages: [apps/web] # bad\u0000\n',
    'packages:\n  - apps/web # bad\u0001\n',
  ]) {
    withTempPnpmWorkspace(workspace, (root) => assertInconclusive(detectStack(root)));
  }
});

test('pnpm preserves admitted Unicode path bytes and opaque unrelated bodies', () => {
  const nelPath = 'apps/web\u0085';
  const nbspPath = 'apps/web\u00a0';
  const nonBmpPath = 'apps/web\u{1f642}';
  withTempPnpmWorkspace(`packages: [${nelPath}, "${nbspPath}", '${nonBmpPath}']\r\n`, (root) => {
    writeTempPackage(root, nelPath, 'nel');
    writeTempPackage(root, nbspPath, 'nbsp');
    writeTempPackage(root, nonBmpPath, 'non-bmp');
    assert.deepEqual(detectStack(root).surfaces.map((surface) => surface.path).sort(), [nelPath, nonBmpPath, nbspPath].sort());
  });

  withTempPnpmWorkspace('catalog:\n  opaque: bad\u0000data\npackages: [apps/web]\n', (root) => {
    assert.deepEqual(detectStack(root).surfaces.map((surface) => surface.path), ['apps/web']);
  });
});

test('pnpm refuses malformed UTF-8 without rejecting explicit replacement-character paths', () => {
  const replacementPath = 'apps/we\ufffdb';
  withTempPnpmWorkspace(`packages: [${replacementPath}]\n`, (root) => {
    writeTempPackage(root, replacementPath, 'replacement');
    assert.deepEqual(detectStack(root).surfaces.map((surface) => surface.path), [replacementPath]);
  });

  withTempPnpmWorkspace('packages: [apps/web]\n', (root) => {
    writeTempPackage(root, replacementPath, 'replacement');
    writeFileSync(join(root, 'pnpm-workspace.yaml'), Buffer.concat([
      Buffer.from('packages: [apps/we'),
      Buffer.from([0xff]),
      Buffer.from('b]\n'),
    ]));
    assertInconclusive(detectStack(root));
  });
});

test('pnpm workspace: only the packages: block is read, not other list keys', () => {
  const r = detectStack(join(here, 'fixtures', 'pnpm-extra-keys'));
  assert.equal(r.monorepo, true);
  // "esbuild"/"node-gyp" live under onlyBuiltDependencies:, not packages:, so
  // they must not be treated as workspace globs (esbuild/ even has a package.json).
  assert.deepEqual(r.surfaces.map((s) => s.name).sort(), ['web']);
});

test('single package: one surface, not a monorepo', () => {
  const r = detectStack(join(here, 'fixtures', 'single-pkg'));
  assert.equal(r.monorepo, false);
  assert.equal(r.surfaces.length, 1);
  assert.equal(r.surfaces[0].test, 'jest');
});

test('unknown stack: returns empty surfaces, never throws', () => {
  const r = detectStack(join(here, 'fixtures'));
  assert.ok(Array.isArray(r.surfaces));
});
