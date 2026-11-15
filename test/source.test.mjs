import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('同一编号在两个块内指向不同线程且定义可迟到', async context => {
  const { base } = await withSource(context);
  const first = (await (await fetch(base + '/chunks/c1')).text()).trim().split('\n').map(JSON.parse);
  const second = (await (await fetch(base + '/chunks/c2')).text()).trim().split('\n').map(JSON.parse);
  assert.equal(first[1].type, 'event'); assert.equal(first[2].id, 1); assert.notEqual(first[2].value, second[2].value);
});
test('尾块截断不影响前块封口声明', async context => {
  const { base, control } = await withSource(context); await control({ truncated: true });
  const chunks = await (await fetch(base + '/recordings/r1/chunks')).json(); assert.equal(chunks[0].sealed, true); assert.equal(chunks[1].sealed, false);
  const raw = await (await fetch(base + '/chunks/c2')).text(); assert.throws(() => JSON.parse(raw.trim().split('\n').at(-1)));
});
