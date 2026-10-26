import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as processGroup from '../scripts/process-group.mjs';

const {
  PROCESS_GROUP_PLATFORMS,
  convergeProcessGroup,
  processGroupAbsent,
  processGroupsSupported,
  signalProcessGroup,
} = processGroup;

const GROUPS_SUPPORTED = process.platform === 'linux' || process.platform === 'darwin';
const PID = 123;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// A scripted group: `present` decides each probe from the probe's call number and
// from how many probes have run since a given signal was sent (1 = first probe after it).
function scriptedGroup(present, { sendThrows = false } = {}) {
  const probes = [];
  const sends = [];
  const sendPids = [];
  const probeCountAtSend = new Map();
  const after = (signalName) => (
    probeCountAtSend.has(signalName) ? probes.length - probeCountAtSend.get(signalName) : 0
  );
  return {
    probes,
    sends,
    sendPids,
    probe(pid) {
      probes.push({ pid, at: Date.now(), absent: false });
      if (!present({ call: probes.length, after })) {
        probes.at(-1).absent = true;
        throw { code: 'ESRCH' };
      }
    },
    send(pid, signalName) {
      sends.push(signalName);
      sendPids.push(pid);
      if (!probeCountAtSend.has(signalName)) probeCountAtSend.set(signalName, probes.length);
      if (sendThrows) throw { code: 'EPERM' };
    },
  };
}

function recordingCalls() {
  const calls = { probe: 0, send: 0 };
  return {
    calls,
    probe() { calls.probe += 1; },
    send() { calls.send += 1; },
  };
}

test('exports exactly the process-group primitive and a frozen platform list', () => {
  assert.deepEqual(Object.keys(processGroup).sort(), [
    'PROCESS_GROUP_PLATFORMS',
    'convergeProcessGroup',
    'processGroupAbsent',
    'processGroupsSupported',
    'signalProcessGroup',
  ]);
  assert.deepEqual(PROCESS_GROUP_PLATFORMS, ['linux', 'darwin']);
  assert.ok(Object.isFrozen(PROCESS_GROUP_PLATFORMS), 'PROCESS_GROUP_PLATFORMS must be frozen');
});

test('processGroupsSupported accepts only linux and darwin', () => {
  assert.equal(processGroupsSupported('linux'), true);
  assert.equal(processGroupsSupported('darwin'), true);
  for (const platform of ['win32', 'aix', 'freebsd', '', undefined]) {
    assert.equal(processGroupsSupported(platform), false, `platform ${String(platform)}`);
  }
});

test('a missing or invalid pid is absent and never reaches the probe or the sender', async () => {
  for (const pid of [undefined, null, 0, -1, 1.5, NaN, '123', 2 ** 53]) {
    const { calls, probe, send } = recordingCalls();
    assert.equal(
      await convergeProcessGroup({ pid, killGraceMs: 10, convergenceMs: 10, probe, send }),
      true,
      `convergeProcessGroup pid ${String(pid)}`,
    );
    assert.equal(processGroupAbsent(pid, { probe }), true, `processGroupAbsent pid ${String(pid)}`);
    assert.equal(signalProcessGroup(pid, 'SIGTERM', { send }), undefined, `signalProcessGroup pid ${String(pid)}`);
    assert.deepEqual(calls, { probe: 0, send: 0 }, `pid ${String(pid)} must not probe or signal`);
  }
});

test('convergeProcessGroup rejects invalid timings with a TypeError before probing', async () => {
  for (const name of ['killGraceMs', 'convergenceMs']) {
    for (const value of [undefined, NaN, -1, Infinity]) {
      // A group that would converge on SIGTERM, so only timing validation can reject.
      const group = scriptedGroup(({ after }) => !after('SIGTERM'));
      const options = {
        pid: PID, killGraceMs: 10, convergenceMs: 10, probe: group.probe, send: group.send, [name]: value,
      };
      await assert.rejects(() => convergeProcessGroup(options), TypeError, `${name} = ${String(value)}`);
      assert.equal(group.probes.length, 0, `${name} = ${String(value)} must not probe`);
      assert.deepEqual(group.sends, [], `${name} = ${String(value)} must not signal`);
    }
  }
});

test('a group absent at start converges without a signal in exactly two probes at zero timings', async () => {
  const zero = scriptedGroup(() => false);
  assert.equal(
    await convergeProcessGroup({ pid: PID, killGraceMs: 0, convergenceMs: 0, probe: zero.probe, send: zero.send }),
    true,
  );
  assert.equal(zero.probes.length, 2);
  assert.deepEqual(zero.sends, []);

  const bounded = scriptedGroup(() => false);
  assert.equal(
    await convergeProcessGroup({ pid: PID, killGraceMs: 30, convergenceMs: 30, probe: bounded.probe, send: bounded.send }),
    true,
  );
  assert.deepEqual(bounded.sends, []);
});

test('a group that appears during the presence wait is terminated', async () => {
  const group = scriptedGroup(({ call, after }) => (after('SIGTERM') ? false : call > 2));
  assert.equal(
    await convergeProcessGroup({ pid: PID, killGraceMs: 50, convergenceMs: 20, probe: group.probe, send: group.send }),
    true,
  );
  assert.deepEqual(group.sends, ['SIGTERM']);
});

test('SIGTERM success is confirmed by a later probe after the confirmation delay', async () => {
  const group = scriptedGroup(({ after }) => !after('SIGTERM'));
  assert.equal(
    await convergeProcessGroup({ pid: PID, killGraceMs: 50, convergenceMs: 40, probe: group.probe, send: group.send }),
    true,
  );
  assert.deepEqual(group.sends, ['SIGTERM']);
  assert.deepEqual(group.sendPids, [PID]);
  assert.ok(group.probes.every((entry) => entry.pid === PID), 'every probe receives the group pid');
  const firstAbsent = group.probes.find((entry) => entry.absent);
  assert.ok(firstAbsent, 'a probe must observe absence');
  const elapsed = group.probes.at(-1).at - firstAbsent.at;
  assert.ok(elapsed >= 35, `confirmation probe ran ${elapsed}ms after absence was first observed`);
});

test('a group that ignores SIGTERM is escalated to SIGKILL', async () => {
  const group = scriptedGroup(({ after }) => !after('SIGKILL'));
  assert.equal(
    await convergeProcessGroup({ pid: PID, killGraceMs: 30, convergenceMs: 30, probe: group.probe, send: group.send }),
    true,
  );
  assert.deepEqual(group.sends, ['SIGTERM', 'SIGKILL']);
});

test('a group that never disappears does not converge', async () => {
  const group = scriptedGroup(() => true);
  assert.equal(
    await convergeProcessGroup({ pid: PID, killGraceMs: 20, convergenceMs: 20, probe: group.probe, send: group.send }),
    false,
  );
  assert.deepEqual(group.sends, ['SIGTERM', 'SIGKILL']);
});

test('D2: probe errors other than ESRCH and a false return never prove absence', async () => {
  const probes = [
    ['EPERM', () => { throw { code: 'EPERM' }; }],
    ['EIO', () => { throw { code: 'EIO' }; }],
    ['Error without code', () => { throw new Error('probe failed'); }],
    ['null', () => { throw null; }],
    ['returns false', () => false],
  ];
  for (const [label, probe] of probes) {
    assert.equal(processGroupAbsent(PID, { probe }), false, `${label}: processGroupAbsent`);
    const sends = [];
    const send = (_pid, signalName) => { sends.push(signalName); };
    assert.equal(
      await convergeProcessGroup({ pid: PID, killGraceMs: 20, convergenceMs: 20, probe, send }),
      false,
      `${label}: convergeProcessGroup`,
    );
    assert.deepEqual(sends, ['SIGTERM', 'SIGKILL'], `${label}: sends`);
  }
});

test('signal errors are ignored and the probe decides convergence', async () => {
  const sends = [];
  const send = (_pid, signalName) => {
    sends.push(signalName);
    throw { code: 'EPERM' };
  };
  assert.doesNotThrow(() => signalProcessGroup(PID, 'SIGTERM', { send }));
  assert.deepEqual(sends, ['SIGTERM']);

  const group = scriptedGroup(({ call }) => call <= 3, { sendThrows: true });
  assert.equal(
    await convergeProcessGroup({ pid: PID, killGraceMs: 30, convergenceMs: 30, probe: group.probe, send: group.send }),
    true,
  );
  assert.ok(group.sends.length >= 1, 'the sender must have been called');
});

test('the confirmation probe catches a group that reappears after SIGTERM', async () => {
  const group = scriptedGroup(({ after }) => {
    if (after('SIGKILL')) return false;
    return after('SIGTERM') !== 1;
  });
  assert.equal(
    await convergeProcessGroup({ pid: PID, killGraceMs: 30, convergenceMs: 30, probe: group.probe, send: group.send }),
    true,
  );
  assert.deepEqual(group.sends, ['SIGTERM', 'SIGKILL']);
});

test('the confirmation probe catches a group that reappears after SIGKILL', async () => {
  const group = scriptedGroup(({ after }) => after('SIGKILL') !== 1);
  assert.equal(
    await convergeProcessGroup({ pid: PID, killGraceMs: 30, convergenceMs: 30, probe: group.probe, send: group.send }),
    false,
  );
  assert.deepEqual(group.sends, ['SIGTERM', 'SIGKILL']);
});

test('a real detached group that ignores SIGTERM converges with the default probe and sender', {
  timeout: 5_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { detached: true, stdio: 'ignore' },
  );
  try {
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'the fixture group must have a pid');
    const deadline = Date.now() + 1_000;
    while (processGroupAbsent(child.pid) && Date.now() < deadline) await sleep(10);
    assert.equal(processGroupAbsent(child.pid), false, 'the fixture group must be present before convergence');
    assert.equal(
      await convergeProcessGroup({ pid: child.pid, killGraceMs: 50, convergenceMs: 1_000, probe: null, send: null }),
      true,
    );
    assert.equal(processGroupAbsent(child.pid), true);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
});
