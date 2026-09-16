import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('Stop hook quotes the plugin-root path so it survives spaces in the path', () => {
  // hooks.json is executed verbatim by Claude Code. The Stop hook calls
  // stop-hook.mjs. If ${CLAUDE_PLUGIN_ROOT} resolves to a path containing a
  // space and the path is unquoted, the shell splits the script path into two
  // arguments and `node` fails. The script path must be double-quoted.
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const commands = hooks.hooks.Stop.flatMap((entry) => entry.hooks)
    .filter((h) => h.type === 'command')
    .map((h) => h.command);
  assert.ok(commands.length > 0, 'expected at least one Stop command hook');
  for (const command of commands) {
    if (!command.includes('${CLAUDE_PLUGIN_ROOT}')) continue;
    assert.match(
      command,
      /"\$\{CLAUDE_PLUGIN_ROOT\}\/[^"]*"/,
      `hook command must quote the plugin-root path: ${command}`
    );
  }
});

test('Stop hook crash on a missing plugin root is fail-safe (errors non-zero, never exit 2)', () => {
  // If ${CLAUDE_PLUGIN_ROOT} is unset/misconfigured, the hook command resolves to
  // `node "/scripts/stop-hook.mjs" .` — a script that does not exist, so
  // node aborts with MODULE_NOT_FOUND. A Claude Code Stop hook only BLOCKS on exit
  // code 2; this crash must surface (non-zero) WITHOUT blocking every Stop, i.e. it
  // must not exit 2. We reproduce it by pointing node at a non-existent script path.
  const bogus = join(root, 'no-such-plugin-root', 'scripts', 'stop-hook.mjs');
  const r = spawnSync(process.execPath, [bogus, '.'], { input: '{}', encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'a missing script must fail loudly');
  assert.notEqual(r.status, 2, 'must not exit 2 — that is the only code that blocks a Stop');
  assert.match(r.stderr, /Cannot find module|MODULE_NOT_FOUND/, 'crash is a module-resolution error');
});
