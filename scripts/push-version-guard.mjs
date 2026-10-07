#!/usr/bin/env node
// Claude Code PreToolUse hook (dev-only, registered in .claude/settings.json — never
// hooks/hooks.json, which ships to plugin users). Blocks `git push` on `main` when the
// plugin version has not moved relative to origin/main, so Claude asks the user whether
// to bump before pushing. Everything else — non-push commands, non-main branches, a
// numerically increased valid version, or unavailable read/parse/git context — must
// never block. Known invalid versions and downgrades are policy failures, not absence.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion, validateVersionTransition } from './version-policy.mjs';

// Kept as path segments for the filesystem read (join() normalizes separators per
// platform) and re-joined with '/' for the git object-path syntax, which always uses
// forward slashes regardless of OS.
const PLUGIN_MANIFEST_PARTS = ['.claude-plugin', 'plugin.json'];
const PLUGIN_MANIFEST_GIT_PATH = PLUGIN_MANIFEST_PARTS.join('/');

// Shared by shouldBlock() and main()'s fast-exit below, so the two never drift.
const PUSH_COMMAND_RE = /\bgit\s+push\b/;

// Pure decision function: no I/O, fully testable with plain fixtures.
export function shouldBlock({ command, branch, headVersion, originVersion }) {
  const isPush = typeof command === 'string' && PUSH_COMMAND_RE.test(command);
  const isMain = branch === 'main';
  const bothKnown = headVersion !== undefined && originVersion !== undefined;
  if (!isPush || !isMain || !bothKnown) return { block: false, reason: '' };
  try {
    validateVersionTransition(headVersion, originVersion);
  } catch (error) {
    let versions = '';
    try {
      parseVersion(headVersion);
      parseVersion(originVersion);
      versions = ` (${headVersion} vs ${originVersion})`;
    } catch { /* Do not echo malformed manifest values into hook diagnostics. */ }
    return {
      block: true,
      reason:
        `steepy push-version-guard: ${error.message} relative to origin/main${versions}. ` +
        `Ask the user whether to bump patch, minor, ` +
        `or major (default suggestion: patch). To bump: run ` +
        `\`node scripts/bump-version.mjs patch\` (or minor/major) and add a matching ` +
        `\`## vX.Y.Z\` section to CHANGELOG.md, then push again.`,
    };
  }
  return { block: false, reason: '' };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// A failing sync git call (e.g. cwd is not a repo, or a ref is missing) would otherwise
// leak a raw "fatal: ..." line: Node's execFileSync/execSync default stdio sends stderr
// straight to the PARENT's stderr (this hook's own stderr) unless stdio is overridden,
// even though the resulting thrown Error is caught by main()'s fail-open try/catch below.
// Silence it explicitly on every git call this script makes.
const GIT_STDIO = ['ignore', 'pipe', 'ignore'];

// Thin orchestrator: gather the four shouldBlock() inputs from the PreToolUse stdin
// payload and the local git checkout, then apply the decision. Returns the process exit
// code (2 to block, 0 otherwise) rather than exiting itself, so tests can call it
// directly. Fail-open: any error along the way (malformed/empty stdin, missing/unreadable
// plugin.json, git not a repo, missing origin/main ref) is swallowed and exits 0 — this
// hook must never brick an unrelated Bash call or a legitimate push.
export async function main() {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const command = payload?.tool_input?.command;

    // Fast exit for the overwhelming majority of Bash calls (this hook's matcher is
    // "Bash", so it runs on every Bash invocation, not just pushes): skip all git/file
    // I/O — and the subprocess cost and any risk of leaked git stderr that comes with
    // it — unless the command actually looks like a push.
    if (typeof command !== 'string' || !PUSH_COMMAND_RE.test(command)) {
      return 0;
    }

    const cwd = process.cwd();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: GIT_STDIO,
    }).trim();
    if (branch !== 'main') return 0;
    const headVersion = JSON.parse(
      readFileSync(join(cwd, ...PLUGIN_MANIFEST_PARTS), 'utf8'),
    ).version;
    const originVersion = JSON.parse(
      execFileSync('git', ['show', `origin/main:${PLUGIN_MANIFEST_GIT_PATH}`], {
        cwd,
        encoding: 'utf8',
        stdio: GIT_STDIO,
      }),
    ).version;

    const { block, reason } = shouldBlock({ command, branch, headVersion, originVersion });
    if (block) {
      process.stderr.write(reason + '\n');
      return 2;
    }
    return 0;
  } catch {
    return 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
