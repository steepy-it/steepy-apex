import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT_FILES = Object.freeze([
  'package.json',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json',
  'cordis.patch.yml',
]);
const AREAS = Object.freeze(['scripts', 'adapters', 'skills']);
const FILE_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function fail(message) { throw new Error(`autopilot runtime: ${message}`); }

function ordinary(path, { optional = false, directory = false } = {}) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    fail(`cannot inspect package path: ${error.message}`);
  }
  if (stat.isSymbolicLink()) fail('symlink in selected engine package');
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) {
    fail(`selected engine package contains a non-ordinary ${directory ? 'directory' : 'file'}`);
  }
  return stat;
}

function packageRoot(engineRoot) {
  if (typeof engineRoot !== 'string' || engineRoot.length === 0) fail('engine root is required');
  const root = realpathSync(resolve(engineRoot));
  ordinary(root, { directory: true });
  return root;
}

function inventory(root) {
  const paths = [];
  for (const area of AREAS) {
    const start = join(root, area);
    ordinary(start, { directory: true });
    const walk = (directory, prefix) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (entry.name === 'node_modules') continue;
        const relative = `${prefix}/${entry.name}`;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          ordinary(absolute, { directory: true });
          walk(absolute, relative);
        } else if (entry.isFile()) {
          ordinary(absolute);
          if (area === 'skills' || /\.(?:mjs|js|json)$/u.test(entry.name)) paths.push(relative);
        } else {
          fail('symlink or unsupported entry in selected engine package');
        }
      }
    };
    walk(start, area);
  }
  for (const relative of ROOT_FILES) {
    const absolute = join(root, relative);
    if (relative.includes('/') && ordinary(dirname(absolute), { directory: true, optional: true }) === null) continue;
    if (ordinary(absolute, { optional: relative !== 'package.json' })) paths.push(relative);
  }
  return paths.sort();
}

export function loadAutopilotRuntime(engineRoot) {
  const root = packageRoot(engineRoot);
  let total = 0;
  const files = inventory(root).map((path) => {
    const absolute = join(root, path);
    const stat = ordinary(absolute);
    if (stat.size > FILE_LIMIT) fail('package file exceeds fingerprint limit');
    const bytes = readFileSync(absolute);
    total += bytes.length;
    if (total > TOTAL_LIMIT) fail('package exceeds fingerprint limit');
    const after = ordinary(absolute);
    if (after.ino !== stat.ino || after.dev !== stat.dev || bytes.length !== stat.size) fail('package file changed during read');
    return Object.freeze({ path, sha256: sha256(bytes), content: bytes.toString('utf8') });
  });
  const fingerprint = sha256(Buffer.from(JSON.stringify(files.map(({ path, sha256: digest }) => [path, digest]))));
  return Object.freeze({ fingerprint, files: Object.freeze(files) });
}

export function fingerprintAutopilotRuntime(engineRoot) {
  const { fingerprint, files } = loadAutopilotRuntime(engineRoot);
  return Object.freeze({ fingerprint, files: Object.freeze(files.map(({ path, sha256: digest }) => Object.freeze({ path, sha256: digest }))) });
}

export function verifyAutopilotRuntime(engineRoot, expected) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)
    || typeof expected.fingerprint !== 'string' || !Array.isArray(expected.files)) {
    fail('invalid expected runtime identity');
  }
  const actual = fingerprintAutopilotRuntime(engineRoot);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('selected runtime fingerprint mismatch');
  return actual;
}
