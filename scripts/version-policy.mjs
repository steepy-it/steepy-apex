// Deliberately narrower than full SemVer: normal X.Y.Z, safe integers only.
export const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?![\s\S])/;

export function parseVersion(value) {
  const match = typeof value === 'string' ? SEMVER_RE.exec(value) : null;
  if (!match) throw new Error('invalid version: expected canonical X.Y.Z');
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('invalid version: components must be safe integers');
  return parts;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function validateVersionTransition(current, previous, { requireIncrement = true } = {}) {
  const comparison = compareVersions(current, previous);
  if (comparison < 0) throw new Error('version downgrade is not permitted');
  if (comparison === 0 && requireIncrement) throw new Error('version must increase');
  return comparison;
}
