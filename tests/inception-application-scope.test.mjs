// Pre-merge code-review fixes for the application scope, driven through fresh CLI processes.
// CR1: application names are literal, so framework route syntax is ordinary inventory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { area, fixture } from './helpers/inception-fixture.mjs';

const ROUTES = {
  'app/[id]/page.tsx': 'Dynamic route\n',
  'app/(shop)/[...slug]/page.tsx': 'Catch-all route\n',
  'app/{draft}/x*?:y.txt': 'Literal name\n',
};
const inventory = (f, ref) => f.read(ref.path).body.files.map(file => file.path);
const unitAfter = (f, id) => f.descriptor().units.find(u => u.id === id).after;
function toApproval(f, exclusions) {
  for (const to of ['architecture', 'research', 'approval']) f.transition(to);
  f.put(`${area}/project/decision-register.md`, 'Approved application decisions');
  f.json(`${area}/project/verification-contract.json`, { ...f.contract, exclusions });
}

test('CR1 bracketed, braced and colon route names round-trip from reconnaissance through bootstrap', t => {
  const f = fixture(t, { git: true, initialFiles: ROUTES });
  f.begin('recon'); f.report('recon'); f.finish('recon');
  for (const path of Object.keys(ROUTES)) assert.ok(inventory(f, unitAfter(f, 'recon')).includes(path), path);
  toApproval(f, [{ path: 'app/[id]/.cache', kind: 'cache', reason: 'Route render cache' }]);
  f.approve(); f.transition('bootstrap');
  f.begin('route', { kind: 'bootstrap', allowedPaths: ['app/[id]'], outputs: [{ path: `${area}/project/route.md`, role: 'report' }, { path: 'app/[id]/page.tsx', role: 'evidence' }] });
  f.put('app/[id]/page.tsx', 'Updated dynamic route\n'); f.put('app/[id]/.cache/render.bin', 'cache\n');
  f.report('route'); f.finish('route');
  const after = inventory(f, unitAfter(f, 'route'));
  assert.ok(after.includes('app/[id]/page.tsx'));
  assert.equal(after.some(path => path.startsWith('app/[id]/.cache')), false);
  assert.equal(f.cli('resume-check').ok, true);
  f.checkpoint();
  // A literal name is still exact scope: an undeclared bracketed change is drift.
  f.put('app/(shop)/[...slug]/page.tsx', 'Unexplained change\n');
  assert.equal(f.refuse('resume-check').ok, false);
});
