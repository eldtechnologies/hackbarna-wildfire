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

test('the live deadline also cancels a retry backoff entered just before eight seconds', {timeout:5000}, async t => {
  const { LiveProvider } = await import('./live');
  t.mock.timers.enable({apis:['setTimeout']});
  const resolveResponses: ((value:Response)=>void)[]=[];
  t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>resolveResponses.push(resolve)));
  const pending=new LiveProvider().getFires();
  let settled=false;
  void pending.catch(()=>{settled=true;});
  assert.equal(resolveResponses.length,3);
  t.mock.timers.tick(7900);
  for(const resolve of resolveResponses) resolve(new Response('',{status:503}));
  await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(100);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,true,'fallback must not wait for the remaining retry backoff');
  await assert.rejects(pending,/abort/i);
  assert.equal(resolveResponses.length,3);
});
