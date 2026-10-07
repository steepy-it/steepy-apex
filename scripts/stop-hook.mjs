#!/usr/bin/env node
// Claude Code Stop-hook adapter. Keeps validate-hub.mjs portable (exit 0/1) and
// owns the Claude-specific block protocol here:
//   - no violations (incl. no .apex hub) -> silent, exit 0
//   - violations, not already in a stop loop -> emit {"decision":"block",...}, exit 0
//   - violations, stop_hook_active === true -> surface on stderr, exit 0 (no loop)
//   - its own crash (e.g. wrong plugin root) -> node errors non-zero, never exit 2
import { collectViolations } from './validate-hub.mjs';

async function readStdinAsync() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const root = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.cwd();

const raw = await readStdinAsync().catch(() => '');
let stopActive = false;
try { stopActive = JSON.parse(raw || '{}').stop_hook_active === true; } catch { /* default false */ }

const violations = collectViolations(root).filter((v) => v.level === 'error');
if (violations.length === 0) {
  process.exit(0);
}
const reason = `steepy validate-hub: ${violations.length} hub violation(s):\n` +
  violations.map((v) => `  - ${v.msg}`).join('\n') +
  `\nFix the hub (or run /steepy-apex:check) before ending the turn.`;
if (stopActive) {
  process.stderr.write(reason + '\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
process.exit(0);
