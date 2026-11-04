// Shared detached-process-group convergence for every controller and
// collector stop path. Only an ESRCH probe error proves a group is gone;
// EPERM and every other probe error stay "not proven" and fail closed.
// Spawning and stream settlement stay with each caller.

const POLL_MS = 10;
const PRESENCE_CAP_MS = 100;
const CONFIRMATION_CAP_MS = 100;

export const PROCESS_GROUP_PLATFORMS = Object.freeze(['linux', 'darwin']);

// Read process.kill at call time so a caller or test can substitute it.
const defaultProbe = (pid) => process.kill(-pid, 0);
const defaultSend = (pid, signalName) => process.kill(-pid, signalName);

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

// -0 would make process.kill signal the caller's own group.
function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

export function processGroupsSupported(platform) {
  return PROCESS_GROUP_PLATFORMS.includes(platform);
}

// Callers run this before spawning: a timing rejected at stop time would leave
// a live group behind.
export function assertTimingMs(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite number >= 0`);
  }
}

export function processGroupAbsent(pid, { probe } = {}) {
  if (!validPid(pid)) return true;
  try {
    (probe ?? defaultProbe)(pid);
  } catch (error) {
    return error?.code === 'ESRCH';
  }
  return false;
}

export function signalProcessGroup(pid, signalName, { send } = {}) {
  if (!validPid(pid)) return;
  try { (send ?? defaultSend)(pid, signalName); } catch { /* the next probe decides */ }
}

// Probe first, then check the deadline, then sleep: a zero timeout probes once.
async function awaitGroupState(pid, wantAbsent, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (processGroupAbsent(pid, { probe }) === wantAbsent) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
}

export async function convergeProcessGroup({
  pid, killGraceMs, convergenceMs, probe, send,
} = {}) {
  assertTimingMs('killGraceMs', killGraceMs);
  assertTimingMs('convergenceMs', convergenceMs);
  if (!validPid(pid)) return true;
  const confirmationMs = Math.min(convergenceMs, CONFIRMATION_CAP_MS);
  if (!await awaitGroupState(pid, false, Math.min(killGraceMs, PRESENCE_CAP_MS), probe)) {
    await delay(confirmationMs);
    if (processGroupAbsent(pid, { probe })) return true;
  }
  signalProcessGroup(pid, 'SIGTERM', { send });
  if (await awaitGroupState(pid, true, killGraceMs, probe)) {
    await delay(confirmationMs);
    if (processGroupAbsent(pid, { probe })) return true;
  }
  signalProcessGroup(pid, 'SIGKILL', { send });
  if (!await awaitGroupState(pid, true, convergenceMs, probe)) return false;
  await delay(confirmationMs);
  return processGroupAbsent(pid, { probe });
}
