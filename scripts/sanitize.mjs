// Shared input sanitization for the scaffolders. Defense in depth:
//  - paths are validated to a safe relative shape (reject the never-legitimate);
//  - single-line free text rejects control chars / newlines (kills structural
//    injection — you need a newline to open a new YAML key or a fake table row);
//  - escapeYamlDouble escapes the residual meta-chars for a YAML double-quoted
//    scalar;
//  - assertSafeHubRoot guards the write-root itself. Zero dependencies (Node built-ins).
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';

const CONTROL = /[\x00-\x1F\x7F]/;
const SAFE_PATH_CHARS = /^[A-Za-z0-9.@_/-]+$/;

// These repository entries are explicit mounts, including external hub/provider
// storage. Descendant links remain subject to each caller's ordinary-file checks.
export const PROJECT_MOUNTS = ['.apex', '.agents', '.claude', '.codex', '.opencode', 'AGENTS.md', 'CLAUDE.md'];

// The single registry of repository-local `.apex/<name>` areas: gitignored
// workflow state that no stable reader, project mount, or planner scan enters.
export const LOCAL_AREA_NAMES = Object.freeze(['work', 'inception']);

// Physical identities of each existing local area under the hub directory.
// `entry` is the literal `.apex/<name>` entry (a directory, or the link itself
// when the area is a symlink); `target` is a linked area's directory target,
// which may alias stable content and must be refused loudly, never skipped.
// An absent or unreadable area has no identity to exclude.
export function localAreaIdentities(apexDir) {
  const identities = [];
  for (const name of LOCAL_AREA_NAMES) {
    const path = join(apexDir, name);
    let entry;
    try { entry = lstatSync(path, { bigint: true }); }
    catch { continue; }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    identities.push(Object.freeze({ name, kind: 'entry', dev: entry.dev, ino: entry.ino }));
    if (!entry.isSymbolicLink()) continue;
    let target;
    try { target = statSync(path, { bigint: true }); }
    catch { continue; }
    if (target.isDirectory()) identities.push(Object.freeze({ name, kind: 'target', dev: target.dev, ino: target.ino }));
  }
  return identities;
}

function identityArea(identities, stat) {
  return identities.find(({ dev, ino }) => stat.dev === dev && stat.ino === ino)?.name ?? null;
}

function pathParts(path) {
  return path.split(sep === '\\' ? /[\\/]+/u : '/').filter((part) => part !== '');
}

function partsPath(parts) {
  return sep === '/' ? `/${parts.join('/')}` : parts.join(sep);
}

// Replays a mount's link text component by component from the repository
// root (or the filesystem root when absolute), before `..` can erase a local
// component: a lexical `.apex/<area>` prefix or a prefix whose metadata is a
// bound area identity (case aliases included) means the text enters an area.
function linkTextLocalArea(root, text, identities) {
  const rootParts = pathParts(resolve(root));
  const stack = isAbsolute(text) ? [] : [...rootParts];
  for (const part of pathParts(text)) {
    if (part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
    if (stack.length === rootParts.length + 2
      && rootParts.every((value, index) => stack[index] === value)
      && stack[rootParts.length] === '.apex'
      && LOCAL_AREA_NAMES.includes(part)) return part;
    if (identities.length === 0) continue;
    try {
      const area = identityArea(identities, lstatSync(partsPath(stack), { bigint: true }));
      if (area) return area;
    } catch {
      // A prefix that does not exist yet cannot be an area.
    }
  }
  return null;
}

// Physical landing: the resolved target or any ancestor is a bound area.
function physicalLocalArea(physical, identities) {
  if (identities.length === 0) return null;
  for (let cursor = physical; ; cursor = dirname(cursor)) {
    const area = identityArea(identities, lstatSync(cursor, { bigint: true }));
    if (area) return area;
    if (dirname(cursor) === cursor) return null;
  }
}

export function bindProjectMount(root, artifactPath) {
  const [name, ...rest] = artifactPath.split('/');
  if (!PROJECT_MOUNTS.includes(name)) return null;
  const logical = join(root, name);
  let link;
  try { link = lstatSync(logical, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!link.isSymbolicLink()) return null;
  let physical;
  try { physical = realpathSync.native(logical); }
  catch (error) { throw new Error(`symlink mount ${name} could not be resolved safely`, { cause: error }); }
  if (physical === dirname(physical)) throw new Error(`symlink mount ${name} targets the filesystem root`);
  const stat = lstatSync(physical, { bigint: true });
  const directory = name.startsWith('.');
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`symlink mount ${name} has wrong target type`);
  }
  if (name !== '.apex') {
    const identities = localAreaIdentities(join(root, '.apex'));
    const area = linkTextLocalArea(root, readlinkSync(logical), identities)
      ?? physicalLocalArea(physical, identities);
    if (area) {
      const error = new Error(`symlink mount ${name} enters excluded .apex/${area}`);
      error.localArea = area;
      throw error;
    }
  }
  return {
    logical, physical, stat, identity: `${link.dev}:${link.ino}`,
    root: dirname(physical), path: [basename(physical), ...rest].join('/'),
  };
}

export function assertSafeRelPath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`unsafe ${label}: must be a non-empty relative path`);
  }
  if (CONTROL.test(value)) {
    throw new Error(`unsafe ${label}: contains a control character`);
  }
  if (value.startsWith('/')) {
    throw new Error(`unsafe ${label}: must be relative, got absolute '${value}'`);
  }
  if (value.split('/').some((seg) => seg === '..')) {
    throw new Error(`unsafe ${label}: must not contain a '..' segment: '${value}'`);
  }
  if (!SAFE_PATH_CHARS.test(value)) {
    throw new Error(`unsafe ${label}: only letters, digits, '.', '@', '_', '-', '/' allowed: '${value}'`);
  }
  return value;
}

export function assertSafeLine(value, label = 'value') {
  if (typeof value !== 'string') {
    throw new Error(`unsafe ${label}: must be a string`);
  }
  if (CONTROL.test(value)) {
    throw new Error(`unsafe ${label}: contains a control character or newline`);
  }
  return value;
}

// Surface test commands are rendered as one line inside a ``` fenced block.
// CommonMark closes that block only when the line contains 0-3 leading spaces,
// at least three backticks, and no other non-whitespace content.
export function assertSafeTestCommand(value, label = 'testCmd') {
  assertSafeLine(value, label);
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error(`unsafe ${label}: must be valid UTF-8`);
  }
  if (/^ {0,3}`{3,}[ \t]*$/u.test(value)) {
    throw new Error(`unsafe ${label}: line closes the emitted Markdown fence`);
  }
  return value;
}

export function escapeYamlDouble(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Resolve a hub write-root, refusing the filesystem root so a fat-fingered `--hub /`
// can never scaffold into '/'. The per-name SAFE_SLUG / assertSafeRelPath checks block
// traversal below the root; this guards the root itself. Shared by both scaffolders.
export function assertSafeHubRoot(hub) {
  const root = resolve(hub);
  if (root === resolve(root, '..')) {
    throw new Error(`refusing to write into the filesystem root: --hub ${hub}`);
  }
  return root;
}
