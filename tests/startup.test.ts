import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartupAttempt, StartupError, waitForReady } from '../src/startup.ts';

test('an unresolved module or image load expires at the shared startup deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempt = new StartupAttempt({ timeoutMs: 100 });
  const work = attempt.wait('texture', () => new Promise<never>(() => {}));
  const failed = assert.rejects(work, error => error instanceof StartupError && error.stage === 'texture' && error.reason === 'timeout');
  await Promise.resolve();
  t.mock.timers.tick(100);
  await failed;
  assert.equal(attempt.signal.aborted, true);
  attempt.finish();
});

test('late resources are disposed instead of reviving a timed-out map', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempt = new StartupAttempt({ timeoutMs: 10 });
  let complete!: (value: { dispose(): void }) => void, disposed = 0;
  const pending = new Promise<{ dispose(): void }>(resolve => { complete = resolve; });
  const work = attempt.wait('geometry', () => pending, value => value.dispose());
  const failed = assert.rejects(work, StartupError);
  await Promise.resolve(); t.mock.timers.tick(10); await failed;
  complete({ dispose() { disposed++; } });
  await pending; await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(disposed, 1);
  attempt.finish();
});

test('a synchronous startup operation that overruns the deadline is rejected too', async () => {
  let now = 0, disposed = 0;
  const attempt = new StartupAttempt({ timeoutMs: 10, now: () => now });
  await assert.rejects(attempt.wait('geometry', () => { now = 20; return {}; }, () => disposed++), StartupError);
  assert.equal(disposed, 1); attempt.finish();
});

test('successful startup clears its timeout and ordinary failures stay catchable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const success = new StartupAttempt({ timeoutMs: 10 });
  assert.equal(await success.wait('terrain', () => 42), 42);
  success.finish(); t.mock.timers.tick(20);
  assert.equal(success.signal.aborted, false);
  const failure = new StartupAttempt();
  await assert.rejects(failure.wait('application', () => { throw new TypeError('Unavailable API'); }), TypeError);
  failure.cancel();
});

test('shader readiness polling stops after timeout, cancellation or a driver error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempt = new StartupAttempt({ timeoutMs: 30 });
  let polls = 0;
  const work = attempt.wait('lighting', () => waitForReady(() => { polls++; return false; }, attempt.signal));
  const failed = assert.rejects(work, StartupError);
  await Promise.resolve(); t.mock.timers.tick(30); await failed;
  const stopped = polls; t.mock.timers.tick(1000);
  assert.equal(polls, stopped); attempt.finish();
  const cancelled = new AbortController(); cancelled.abort(new Error('Cancelled'));
  await assert.rejects(waitForReady(() => { throw Error('Must not poll'); }, cancelled.signal), /Cancelled/);
  await assert.rejects(waitForReady(() => { throw Error('Context lost'); }, new AbortController().signal), /Context lost/);
  await waitForReady(() => true, new AbortController().signal);
});
