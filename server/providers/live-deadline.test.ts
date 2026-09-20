import test from 'node:test';
import assert from 'node:assert/strict';

test('an eight-second live deadline aborts all collection requests and does not retry aborted work', async t => {
  process.env.DEEPFIRE_API_KEY = 'test-only-not-a-secret';
  const { LiveProvider } = await import('./live');
  t.mock.timers.enable({apis:['setTimeout']});
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const signal = (init as RequestInit).signal!;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once:true});
    });
  });
  const pending = new LiveProvider().getFires();
  assert.equal(signals.length, 3);
  t.mock.timers.tick(8000);
  await assert.rejects(pending, /aborted/);
  assert.ok(signals.every(signal => signal.aborted));
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(signals.length, 3);
});
