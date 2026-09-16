#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseVersion } from './version-policy.mjs';

export const EVIDENCE_JSON_PATH = 'docs/native-test-evidence.json';
export const EVIDENCE_ARTIFACT_PATH = 'docs/native-test-evidence.md';
export const EVIDENCE_CLOSURE_REPORT_PATH = 'docs/release-audit-remediation.md';
export const EVIDENCE_RECORD_IDS = Object.freeze([
  'plugin-preflight',
  'claude-code',
  'codex',
  'opencode',
  'pi',
  'deepseek-harness',
]);
export const REQUIRED_CAPABILITIES = Object.freeze({
  'plugin-preflight': Object.freeze([
    'manifest-version-lockstep',
    'version-transaction-complete',
    'npm-package-composition',
    'hub-coherence',
  ]),
  'claude-code': Object.freeze([
    'plugin-install-load',
    'skill-discovery',
    'skill-invocation',
    'generated-project-bootstrap',
    'scaffold-check-workflow',
    'native-specialist-behavior',
  ]),
  codex: Object.freeze([
    'plugin-install-load',
    'skill-discovery',
    'skill-invocation',
    'generated-project-bootstrap',
    'scaffold-check-workflow',
    'native-specialist-dispatch',
  ]),
  opencode: Object.freeze([
    'plugin-install-load',
    'skill-discovery',
    'skill-invocation',
    'generated-project-bootstrap',
    'scaffold-check-workflow',
    'native-specialist-behavior',
  ]),
  pi: Object.freeze(['package-extension-load', 'skill-invocation', 'session-transitions']),
  'deepseek-harness': Object.freeze([
    'plugin-load',
    'commands',
    'model-callable-skill-tool',
    'bootstrap-lifecycle',
  ]),
});

const EXCLUDED_EVIDENCE_PATHS = new Set([
  EVIDENCE_JSON_PATH,
  EVIDENCE_ARTIFACT_PATH,
  EVIDENCE_CLOSURE_REPORT_PATH,
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_AGE_DAYS = 30;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/u;
const REDACTION_MARKERS = new Set(['<redacted>', '[redacted]', 'REDACTED']);
const CREDENTIAL_VALUE_PATTERNS = [
  /\b(?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s'";]+)/gi,
  /--(?:api[-_]?key|token|secret|password)\b(?:\s+|=)([^\s'";]+)/gi,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+([^\s'";]+)/gi,
  /\bBearer\s+([^\s'";]+)/gi,
  /\b(?:X[-_])?(?:API[-_]?KEY|TOKEN|SECRET|PASSWORD)\s*:\s*([^\s'";]+)/gi,
  /\b(?:Cookie|Set-Cookie)\s*:\s*[A-Z0-9._-]+\s*=\s*([^\s'";]+)/gi,
];

function fail(message) {
  throw new Error(`release evidence: ${message}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label);
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} has unknown field: ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing field: ${key}`);
  }
}

function assertText(value, label, { max = 512 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !SAFE_TEXT_RE.test(value)) {
    fail(`${label} must be non-empty bounded single-line text`);
  }
  return value;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const seen = new Set();
  for (const item of value) {
    assertText(item, label);
    if (seen.has(item)) fail(`${label} must not contain duplicates`);
    seen.add(item);
  }
}

function assertNoUnredactedCredential(value, label) {
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      if (!REDACTION_MARKERS.has(match[1])) fail(`${label} contains credential-like content`);
    }
  }
}

function assertConfinedPath(root, path, label) {
  assertText(path, label);
  if (isAbsolute(path) || path.includes('\\')) fail(`${label} must be a canonical relative path`);
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${label} must be a canonical relative path`);
  }
  const absolute = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolute.startsWith(prefix)) fail(`${label} escapes the repository`);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) fail(`${label} must not traverse a symlink`);
  }
  return absolute;
}

function hashFrame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function productInputs(rootInput, packagePaths) {
  const root = resolve(rootInput);
  if (!Array.isArray(packagePaths) || packagePaths.length === 0) fail('npm package file list is empty');
  const paths = [...packagePaths];
  if (new Set(paths).size !== paths.length) fail('npm package file list contains duplicates');
  paths.sort();

  const inputs = [];
  for (const path of paths) {
    if (EXCLUDED_EVIDENCE_PATHS.has(path)) continue;
    const absolute = assertConfinedPath(root, path, 'npm package path');
    const info = statSync(absolute);
    if (!info.isFile()) fail(`npm package path is not an ordinary file: ${path}`);
    inputs.push({ path, mode: info.mode & 0o777, bytes: readFileSync(absolute) });
  }
  if (inputs.length === 0) fail('npm package has no product inputs after evidence exclusion');
  return inputs;
}

export function computePayloadIdentity(rootInput, packagePaths) {
  const hash = createHash('sha256');
  hash.update('steepy-apex-release-payload-v1\0');
  for (const input of productInputs(rootInput, packagePaths)) {
    hashFrame(hash, input.path);
    hashFrame(hash, String(input.mode));
    hashFrame(hash, input.bytes);
  }
  return hash.digest('hex');
}

function runGit(root, args, label, { encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${label}: ${String(result.stderr ?? result.error?.message ?? `exit ${result.status}`).trim()}`);
  }
  return result.stdout;
}

function materializeSourceTree(root, sourceRevision) {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'steepy-release-evidence-source-'));
  try {
    const tree = runGit(
      root,
      ['ls-tree', '-r', '-z', '--full-tree', sourceRevision],
      'source tree is unavailable',
      { encoding: null },
    );
    const seenPaths = new Set();
    let offset = 0;
    while (offset < tree.length) {
      const end = tree.indexOf(0, offset);
      if (end === -1) fail('source tree entry is truncated');
      const entry = tree.subarray(offset, end);
      offset = end + 1;
      const separator = entry.indexOf(0x09);
      if (separator === -1) fail('source tree entry is invalid');
      const header = entry.subarray(0, separator).toString('ascii');
      const match = /^(100644|100755) blob ([a-f0-9]{40})$/.exec(header);
      if (!match) fail('source tree contains an unsupported entry');
      const pathBytes = entry.subarray(separator + 1);
      const path = pathBytes.toString('utf8');
      if (!Buffer.from(path).equals(pathBytes) || !path || path.includes('\\')) {
        fail('source tree path is invalid');
      }
      const parts = path.split('/');
      if (parts.some((part) => part === '' || part === '.' || part === '..') || seenPaths.has(path)) {
        fail('source tree path is invalid');
      }
      seenPaths.add(path);
      const destination = resolve(sourceRoot, ...parts);
      if (!destination.startsWith(`${sourceRoot}${sep}`)) fail('source tree path escapes its root');
      const mode = Number.parseInt(match[1].slice(-3), 8);
      const bytes = runGit(root, ['cat-file', 'blob', match[2]], 'source blob is unavailable', { encoding: null });
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { mode });
      chmodSync(destination, mode);
    }
    return sourceRoot;
  } catch (error) {
    rmSync(sourceRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertSourceProductIdentity(root, sourceRevision, currentPackagePaths) {
  const source = runGit(root, ['rev-parse', '--verify', `${sourceRevision}^{commit}`], 'source revision is unavailable').trim();
  if (source !== sourceRevision) fail('source revision is unavailable');
  runGit(root, ['merge-base', '--is-ancestor', sourceRevision, 'HEAD'], 'source revision is not reachable from current HEAD');

  const sourceRoot = materializeSourceTree(root, sourceRevision);
  try {
    const sourceInputs = productInputs(sourceRoot, collectNpmPackagePaths(sourceRoot));
    const currentInputs = productInputs(root, currentPackagePaths);
    if (sourceInputs.length !== currentInputs.length) fail('source product identity mismatch');
    for (let index = 0; index < sourceInputs.length; index += 1) {
      const sourceInput = sourceInputs[index];
      const currentInput = currentInputs[index];
      if (
        sourceInput.path !== currentInput.path
        || sourceInput.mode !== currentInput.mode
        || !sourceInput.bytes.equals(currentInput.bytes)
      ) {
        fail('source product identity mismatch');
      }
    }
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`${label} is missing or unreadable: ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

export function validateProductState(rootInput, packagePaths) {
  const root = resolve(rootInput);
  const manifests = [
    ['package.json', readJson(join(root, 'package.json'), 'package.json')],
    ['.claude-plugin/plugin.json', readJson(join(root, '.claude-plugin', 'plugin.json'), 'Claude manifest')],
    ['.codex-plugin/plugin.json', readJson(join(root, '.codex-plugin', 'plugin.json'), 'Codex manifest')],
  ];
  const version = manifests[0][1].version;
  parseVersion(version);
  for (const [path, manifest] of manifests) {
    parseVersion(manifest.version);
    if (manifest.version !== version) fail(`incomplete bump: ${path} version does not match package.json`);
  }
  if (existsSync(join(root, '.steepy-version-transaction.json'))) {
    fail('incomplete bump: .steepy-version-transaction.json is present');
  }
  let changelog;
  try {
    changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  } catch (error) {
    fail(`CHANGELOG.md is missing or unreadable: ${error.code ?? error.message}`);
  }
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^## v${escaped} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, 'm').test(changelog)) {
    fail(`incomplete bump: CHANGELOG.md has no heading for v${version}`);
  }
  return { productVersion: version, payloadSha256: computePayloadIdentity(root, packagePaths) };
}

function parseObservedDate(value, now, recordId) {
  const match = typeof value === 'string' ? DATE_RE.exec(value) : null;
  if (!match) fail(`${recordId}: observedAt must be canonical YYYY-MM-DD`);
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const observed = new Date(timestamp);
  if (observed.toISOString().slice(0, 10) !== value) fail(`${recordId}: observedAt is invalid`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (timestamp > today) fail(`${recordId}: evidence date is in the future`);
  if (today - timestamp > MAX_EVIDENCE_AGE_DAYS * DAY_MS) fail(`${recordId}: evidence is stale`);
}

function validateArtifact(artifact, root, recordId) {
  assertExactKeys(artifact, ['path', 'sha256', 'redacted'], `${recordId}.artifact`);
  if (artifact.path !== EVIDENCE_ARTIFACT_PATH) {
    fail(`${recordId}: artifact path must be ${EVIDENCE_ARTIFACT_PATH}`);
  }
  if (artifact.redacted !== true) fail(`${recordId}: evidence artifact must be redacted`);
  if (!SHA256_RE.test(artifact.sha256)) fail(`${recordId}: artifact sha256 is invalid`);
  let bytes;
  try {
    bytes = readFileSync(assertConfinedPath(root, artifact.path, `${recordId} artifact path`));
  } catch (error) {
    fail(`${recordId}: artifact path is missing or unreadable: ${error.code ?? error.message}`);
  }
  if (bytes.length === 0) fail(`${recordId}: artifact must not be empty`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) fail(`${recordId}: artifact must be valid UTF-8 text`);
  assertNoUnredactedCredential(text, `${recordId}: artifact`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== artifact.sha256) fail(`${recordId}: artifact digest mismatch`);
}

function validateRecord(record, { root, now, productVersion, payloadSha256 }) {
  assertExactKeys(record, [
    'id', 'sourceRevision', 'payloadSha256', 'productVersion', 'host', 'observedAt',
    'installation', 'checks', 'artifact', 'result',
  ], 'evidence record');
  const { id } = record;
  if (!EVIDENCE_RECORD_IDS.includes(id)) fail(`unknown evidence record: ${id}`);
  if (record.result !== 'PASS') fail(`${id}: result must be PASS`);
  if (!REVISION_RE.test(record.sourceRevision)) fail(`${id}: source revision must be a full lowercase commit SHA`);
  if (record.payloadSha256 !== payloadSha256) fail(`${id}: payload identity mismatch`);
  if (record.productVersion !== productVersion) fail(`${id}: product version mismatch`);
  parseObservedDate(record.observedAt, now, id);

  assertExactKeys(record.host, ['name', 'version', 'platform', 'profile'], `${id}.host`);
  if (record.host.name !== id) fail(`${id}: host name must match record id`);
  for (const field of ['name', 'version', 'platform', 'profile']) assertText(record.host[field], `${id}.host.${field}`);

  assertExactKeys(record.installation, ['method', 'composition'], `${id}.installation`);
  assertText(record.installation.method, `${id}.installation.method`);
  assertStringArray(record.installation.composition, `${id}.installation.composition`);

  if (!Array.isArray(record.checks)) fail(`${id}.checks must be an array`);
  const expected = REQUIRED_CAPABILITIES[id];
  const seen = new Set();
  for (const check of record.checks) {
    assertExactKeys(check, ['capability', 'command', 'result'], `${id}.check`);
    assertText(check.capability, `${id}.check.capability`);
    assertText(check.command, `${id}.check.command`, { max: 2048 });
    assertNoUnredactedCredential(check.command, `${id}: command`);
    if (check.result !== 'PASS') fail(`${id}:${check.capability} must be PASS`);
    if (!expected.includes(check.capability)) fail(`${id}: unknown capability: ${check.capability}`);
    if (seen.has(check.capability)) fail(`${id}: duplicate capability: ${check.capability}`);
    seen.add(check.capability);
  }
  for (const capability of expected) {
    if (!seen.has(capability)) fail(`${id}: missing capability: ${capability}`);
  }
  validateArtifact(record.artifact, root, id);
}

export function validateReleaseEvidence(evidence, { root: rootInput, packagePaths, now = new Date() }) {
  const root = resolve(rootInput);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('now must be a valid Date');
  assertExactKeys(evidence, ['schemaVersion', 'records'], 'evidence document');
  if (evidence.schemaVersion !== 1) fail('unsupported schemaVersion');
  if (!Array.isArray(evidence.records)) fail('records must be an array');

  const product = validateProductState(root, packagePaths);
  const seen = new Set();
  for (const record of evidence.records) {
    if (record && EVIDENCE_RECORD_IDS.includes(record.id) && seen.has(record.id)) {
      fail(`duplicate evidence record: ${record.id}`);
    }
    validateRecord(record, { root, now, ...product });
    seen.add(record.id);
  }
  for (const id of EVIDENCE_RECORD_IDS) {
    if (!seen.has(id)) fail(`missing evidence record: ${id}`);
  }
  const sourceRevisions = [...new Set(evidence.records.map((record) => record.sourceRevision))].sort();
  if (sourceRevisions.length !== 1) fail('source revisions must all match');
  assertSourceProductIdentity(root, sourceRevisions[0], packagePaths);
  return {
    ...product,
    sourceRevisions,
  };
}

export function collectNpmPackagePaths(rootInput) {
  const root = resolve(rootInput);
  const cache = mkdtempSync(join(tmpdir(), 'steepy-release-pack-cache-'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const result = spawnSync(
      npm,
      ['--cache', cache, 'pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.status !== 0) fail(`npm pack failed: ${String(result.stderr).trim() || `exit ${result.status}`}`);
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      fail(`npm pack returned invalid JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].files)) {
      fail('npm pack returned an unexpected file manifest');
    }
    return parsed[0].files.map((entry) => entry.path);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        root: { type: 'string' },
        evidence: { type: 'string' },
        'product-only': { type: 'boolean', default: false },
      },
    }));
    const root = resolve(cwd, values.root ?? '.');
    const packagePaths = collectNpmPackagePaths(root);
    const product = validateProductState(root, packagePaths);
    if (values['product-only']) {
      console.log(JSON.stringify({ status: 'PASS', ...product }));
      return 0;
    }
    const evidencePath = values.evidence ?? EVIDENCE_JSON_PATH;
    const absoluteEvidencePath = isAbsolute(evidencePath)
      ? evidencePath
      : resolve(root, evidencePath);
    const relativeEvidencePath = relative(root, absoluteEvidencePath);
    if (relativeEvidencePath.startsWith('..') || isAbsolute(relativeEvidencePath)) {
      fail('evidence path must stay inside the repository');
    }
    const evidence = readJson(absoluteEvidencePath, 'release evidence');
    const receipt = validateReleaseEvidence(evidence, { root, packagePaths });
    console.log(JSON.stringify({ status: 'PASS', ...receipt }));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isEntry = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) process.exitCode = main();
