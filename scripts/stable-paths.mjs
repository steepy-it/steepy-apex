// Physical reader for stable repository documentation (the `.apex/` hub, root
// instructions, provider namespaces). Shared by the hub linter and any later
// stable reader; it depends only on Node built-ins and sanitize.mjs, so it can
// never close an import cycle through a consumer.
//
// Root admission rejects parent traversal and a direct root symlink before one
// physical identity is established. The exact `.apex` entry and the supported
// project entries may be relative or absolute symlink mounts: each physical
// target is bound once while callers keep logical repository-relative paths.
// Every inspection validates raw native path components before `..` is
// resolved, refuses descendant links and non-files, and never enters a
// repository-local area (LOCAL_AREAS) by name or by bound physical identity.
// Reads open no-follow/non-blocking, bind the descriptor to the inspected
// identity, and stay bounded even if a file grows. Failures are collected as
// deduplicated diagnostics; nothing is ever written.
import {
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { bindProjectMount, PROJECT_MOUNTS } from './sanitize.mjs';

export const MAX_STABLE_FILE_BYTES = 1024 * 1024;

// The single registry of repository-local `.apex` areas that stable readers
// never enter. `path` is the logical repository-relative directory named by the
// `enters excluded <path>` diagnostic; `physicalReason` tags the refusal.
export const LOCAL_AREAS = Object.freeze([
  Object.freeze({ name: 'work', path: '.apex/work', physicalReason: 'work-path' }),
]);

export function displayNativePath(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function splitNativePath(path) {
  return sep === '\\' ? path.split(/[\\/]+/u) : path.split('/');
}

function localAreaOf(logicalPath) {
  return LOCAL_AREAS.find((area) => (
    logicalPath === area.path || logicalPath.startsWith(`${area.path}/`)
  )) ?? null;
}

export function admitHubRoot(hubRoot) {
  const raw = typeof hubRoot === 'string' && hubRoot.length > 0 ? hubRoot : process.cwd();
  if (splitNativePath(raw).includes('..')) {
    return {
      state: 'unsafe',
      root: resolve(raw),
      reason: 'contains unsupported parent traversal',
    };
  }

  const lexical = resolve(raw);
  let stat;
  try {
    stat = lstatSync(lexical, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', root: lexical };
    return { state: 'unsafe', root: lexical, reason: 'is unreadable' };
  }
  if (stat.isSymbolicLink()) return { state: 'unsafe', root: lexical, reason: 'is symlink' };
  if (!stat.isDirectory()) return { state: 'unsafe', root: lexical, reason: 'is non-directory' };
  try {
    return { state: 'present', root: realpathSync.native(lexical) };
  } catch {
    return { state: 'unsafe', root: lexical, reason: 'could not be resolved safely' };
  }
}

// Lexically replays base + target component by component and returns the
// local area the walk passes through at any point, or null. Case aliases are
// left to the reader's physical-identity check.
export function rawPathEntersLocalArea(base, target) {
  const stack = [];
  for (const component of [...splitNativePath(base), ...splitNativePath(target)]) {
    if (component === '' || component === '.') continue;
    if (component === '..') stack.pop();
    else stack.push(component);
    const area = localAreaOf(displayNativePath(stack.join(sep)));
    if (area) return area;
  }
  return null;
}

// The repository's exact .apex entry is an explicit hub mount. Resolve it
// once; all descendants still pass ordinary-file/component admission.
export function bindApexRoot(root) {
  const lexical = join(root, '.apex');
  let entry;
  try {
    entry = lstatSync(lexical, { bigint: true });
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'unsafe', reason: 'is unreadable' };
  }
  try {
    const path = entry.isSymbolicLink() ? realpathSync.native(lexical) : lexical;
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory()) return { state: 'unsafe', reason: 'is non-directory' };
    return { state: 'present', path, stat };
  } catch {
    return { state: 'unsafe', reason: 'could not be resolved safely' };
  }
}

// A local area that is an ordinary directory under the bound hub is excluded by
// its physical identity too, so a case alias cannot reach it.
function bindLocalAreaIdentities(apex) {
  if (apex.state !== 'present') return [];
  const identities = [];
  for (const area of LOCAL_AREAS) {
    try {
      const stat = lstatSync(join(apex.path, ...area.path.split('/').slice(1)), { bigint: true });
      if (stat.isDirectory()) identities.push({ area, dev: stat.dev, ino: stat.ino });
    } catch {
      // An absent or unreadable area has no identity to exclude.
    }
  }
  return identities;
}

// Stable documentation is read through one physical capability. It admits raw
// native path components before resolving `..`, rejects links/non-files, then
// opens with no-follow + non-blocking flags and binds the descriptor to the
// lstat identity. Incremental reads enforce the cap even if a file grows.
export function createStableReader(hubRoot, diagnostics = [], rootAdmission = admitHubRoot(hubRoot)) {
  const root = rootAdmission.root;
  const apex = rootAdmission.state === 'present' ? bindApexRoot(root) : { state: 'missing' };
  const localAreaIdentities = bindLocalAreaIdentities(apex);
  const mounts = new Map();
  if (rootAdmission.state === 'present') {
    for (const name of PROJECT_MOUNTS.filter((name) => name !== '.apex')) {
      try {
        const mount = bindProjectMount(root, name);
        if (mount) mounts.set(name, { state: 'present', ...mount });
      } catch {
        mounts.set(name, { state: 'unsafe' });
      }
    }
  }
  const physicalPath = (parts) => parts[0] === '.apex' && apex.state === 'present'
    ? join(apex.path, ...parts.slice(1))
    : mounts.get(parts[0])?.state === 'present'
      ? join(mounts.get(parts[0]).physical, ...parts.slice(1))
      : join(root, ...parts);
  const diagnosed = new Set();
  const report = (label, reason) => {
    const key = `${label}\0${reason}`;
    if (diagnosed.has(key)) return;
    diagnosed.add(key);
    diagnostics.push({ level: 'error', msg: `stable-read: ${label} ${reason}` });
  };
  if (rootAdmission.state === 'unsafe') report('hub root', rootAdmission.reason);

  function localAreaRefusal(area, display, reportUnsafe) {
    if (reportUnsafe) report(display, `enters excluded ${area.path}`);
    return { state: 'unsafe', label: display, physicalReason: area.physicalReason, localArea: area.name };
  }

  function inspect(rawPath, { base = '', kind = 'file', reportUnsafe = true } = {}) {
    // A root that was not admitted yields nothing beyond its one diagnostic.
    if (rootAdmission.state !== 'present') return { state: rootAdmission.state };
    if (typeof rawPath !== 'string' || rawPath.length === 0 || isAbsolute(rawPath)) {
      if (reportUnsafe) report(rawPath || '.', 'escapes the repository root');
      return { state: 'unsafe' };
    }
    // POSIX backslash is a legal filename byte. Windows accepts both native
    // separator spellings; do not impose Windows splitting on POSIX paths.
    const baseParts = splitNativePath(base).filter((part) => part !== '' && part !== '.');
    const rawParts = splitNativePath(rawPath);
    const display = displayNativePath([base, rawPath].filter(Boolean).join(sep));
    const stack = [];
    let cursor = root;
    const parts = [...baseParts, ...rawParts];

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (stack.length === 0) {
          if (reportUnsafe) report(display, 'escapes the repository root');
          return { state: 'unsafe', label: display, physicalReason: 'outside-root' };
        }
        stack.pop();
        cursor = physicalPath(stack);
        continue;
      }

      const candidateStack = [...stack, part];
      const candidateRel = candidateStack.join('/');
      const namedArea = localAreaOf(candidateRel);
      if (namedArea) return localAreaRefusal(namedArea, display, reportUnsafe);
      if (candidateRel === '.apex' && apex.state !== 'present') {
        if (apex.state === 'unsafe' && reportUnsafe) report(display, apex.reason);
        return { state: apex.state, label: display };
      }
      if (mounts.get(candidateRel)?.state === 'unsafe') {
        if (reportUnsafe) report(display, 'symlink mount could not be resolved safely');
        return { state: 'unsafe', label: display, physicalReason: 'symlink' };
      }
      cursor = physicalPath(candidateStack);
      let stat;
      try {
        stat = lstatSync(cursor, { bigint: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return { state: 'missing', label: display };
        if (reportUnsafe) report(display, 'is unreadable');
        return { state: 'unsafe', label: display, physicalReason: 'unreadable' };
      }
      if (candidateRel === '.apex'
        && (!stat.isDirectory() || stat.dev !== apex.stat.dev || stat.ino !== apex.stat.ino)) {
        if (reportUnsafe) report(display, 'changed physical identity');
        return { state: 'unsafe', label: display };
      }
      const mount = mounts.get(candidateRel);
      if (mount?.state === 'present'
        && (stat.dev !== mount.stat.dev || stat.ino !== mount.stat.ino)) {
        if (reportUnsafe) report(display, 'changed physical identity');
        return { state: 'unsafe', label: display };
      }
      const boundArea = stat.isDirectory()
        ? localAreaIdentities.find(({ dev, ino }) => stat.dev === dev && stat.ino === ino)?.area
        : undefined;
      if (boundArea) return localAreaRefusal(boundArea, display, reportUnsafe);
      const hasLaterComponent = index < parts.length - 1;
      if (stat.isSymbolicLink()) {
        if (reportUnsafe) report(display, hasLaterComponent ? 'has symlinked component' : 'is symlink');
        return {
          state: 'unsafe',
          label: display,
          physicalReason: hasLaterComponent ? 'symlinked-ancestor' : 'symlink',
        };
      }
      if (hasLaterComponent && !stat.isDirectory()) {
        if (reportUnsafe) report(display, 'has non-directory component');
        return { state: 'unsafe', label: display, physicalReason: 'non-directory-ancestor' };
      }
      stack.push(part);
    }

    let finalStat;
    try {
      finalStat = lstatSync(cursor, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'missing', label: display };
      if (reportUnsafe) report(display, 'is unreadable');
      return { state: 'unsafe', label: display, physicalReason: 'unreadable' };
    }
    const valid = kind === 'directory'
      ? finalStat.isDirectory()
      : kind === 'entry'
        ? finalStat.isDirectory() || finalStat.isFile()
        : finalStat.isFile();
    if (!valid) {
      if (reportUnsafe) report(display, kind === 'directory' ? 'is non-directory' : 'is non-file');
      return {
        state: 'unsafe',
        label: display,
        physicalReason: kind === 'directory' ? 'non-directory' : 'non-file',
      };
    }
    return { state: 'present', label: display, path: join(root, ...stack), physicalPath: cursor, stat: finalStat };
  }

  function read(rawPath, options = {}) {
    const admitted = inspect(rawPath, { ...options, kind: 'file' });
    if (admitted.state !== 'present') return { ...admitted, text: undefined };
    const reportUnsafe = options.reportUnsafe !== false;
    if (admitted.stat.size > BigInt(MAX_STABLE_FILE_BYTES)) {
      if (reportUnsafe) report(admitted.label, `exceeds ${MAX_STABLE_FILE_BYTES} bytes`);
      return { state: 'unsafe', label: admitted.label, text: undefined };
    }

    let fd;
    try {
      const noFollow = typeof FS_CONSTANTS.O_NOFOLLOW === 'number' ? FS_CONSTANTS.O_NOFOLLOW : 0;
      const nonBlock = typeof FS_CONSTANTS.O_NONBLOCK === 'number' ? FS_CONSTANTS.O_NONBLOCK : 0;
      fd = openSync(admitted.physicalPath, FS_CONSTANTS.O_RDONLY | noFollow | nonBlock);
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile()
        || opened.dev !== admitted.stat.dev
        || opened.ino !== admitted.stat.ino) {
        if (reportUnsafe) report(admitted.label, 'changed physical identity during open');
        return { state: 'unsafe', label: admitted.label, text: undefined };
      }
      if (opened.size > BigInt(MAX_STABLE_FILE_BYTES)) {
        if (reportUnsafe) report(admitted.label, `exceeds ${MAX_STABLE_FILE_BYTES} bytes`);
        return { state: 'unsafe', label: admitted.label, text: undefined };
      }

      const chunks = [];
      let total = 0;
      while (total <= MAX_STABLE_FILE_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_STABLE_FILE_BYTES + 1 - total));
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        total += count;
        if (total > MAX_STABLE_FILE_BYTES) {
          if (reportUnsafe) report(admitted.label, `grew beyond ${MAX_STABLE_FILE_BYTES} bytes`);
          return { state: 'unsafe', label: admitted.label, text: undefined };
        }
        chunks.push(chunk.subarray(0, count));
      }
      return { ...admitted, text: Buffer.concat(chunks, total).toString('utf8') };
    } catch {
      if (reportUnsafe) report(admitted.label, 'could not be opened safely');
      return { state: 'unsafe', label: admitted.label, text: undefined };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* validation already has its result */ }
      }
    }
  }

  const fromAbsolute = (path) => relative(root, path);
  return { diagnostics, fromAbsolute, inspect, read, report, root };
}
