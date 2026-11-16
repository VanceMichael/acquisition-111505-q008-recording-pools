import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

async function withServices(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    intake.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const intakeBase = `http://127.0.0.1:${intake.address().port}`;
  const sourceBase = `http://127.0.0.1:${provider.address().port}`;
  const control = value => fetch(sourceBase + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { intakeBase, sourceBase, control };
}

const collect = (base, source) => fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });

test('自动采集结构化事件并按块隔离相同常量编号', async context => {
  const { intakeBase, sourceBase } = await withServices(context);
  const response = await collect(intakeBase, sourceBase);
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.chunks.length, 2);
  assert.deepEqual(report.chunks.map(chunk => chunk.status), ['accepted', 'accepted']);

  const events = await (await fetch(intakeBase + '/api/events')).json();
  assert.equal(events.length, 2);
  const [first, second] = events;
  assert.equal(first.processId, 'app-1');
  assert.equal(first.event.references.thread.value, '接待线程');
  assert.equal(second.event.references.thread.value, '装箱线程');
  assert.notEqual(first.receipt, '');
  // 时钟依据随事件回到原始块
  assert.equal(first.event.clock.ticksPerSecond, 1000);
  assert.equal(second.event.clock.ticksPerSecond, 2000);
  assert.equal(first.event.clock.wallTime, '2026-11-01T00:00:00.500Z');
  assert.equal(second.event.clock.wallTime, '2026-10-31T23:59:59.750Z');
  // 堆栈经 frame->method 链解析
  assert.equal(first.event.references.stack.frames[0].method.value, 'receive');

  const chunks = await (await fetch(intakeBase + '/api/chunks')).json();
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map(chunk => chunk.complete), [true, true]);
});

test('尾块截断时前块照常接收且缺口不被说成没有事件', async context => {
  const { intakeBase, sourceBase, control } = await withServices(context);
  await control({ truncated: true });
  const response = await collect(intakeBase, sourceBase);
  assert.equal(response.status, 201);
  const report = await response.json();
  const [c1, c2] = report.chunks;
  assert.equal(c1.status, 'accepted');
  assert.equal(c2.status, 'accepted');
  assert.equal(c2.complete, false);
  assert.ok(c2.tailGap);
  const events = await (await fetch(intakeBase + '/api/events?chunkId=c2')).json();
  assert.equal(events.length, 1);
  assert.equal(events[0].chunkComplete, false);
  assert.ok(events[0].tailGap);
});

test('迟到且最终缺失的常量定义保留未解析编号而不是空字符串', async context => {
  const { intakeBase, sourceBase, control } = await withServices(context);
  await control({ unresolved: true });
  const response = await collect(intakeBase, sourceBase);
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.deepEqual(report.chunks.map(chunk => chunk.status), ['accepted', 'accepted']);
  const events = await (await fetch(intakeBase + '/api/events?chunkId=c1')).json();
  const frame = events[0].event.references.stack.frames[0];
  assert.equal(frame.status, 'unresolved');
  assert.equal(frame.id, 3);
  assert.equal(frame.value, undefined);
  assert.equal(events[0].event.unresolved, true);
  assert.equal(events[0].event.references.thread.status, 'resolved');
});

test('单块畸形时返回 207 且不影响其他块接收', async context => {
  const { intakeBase, sourceBase } = await withServices(context);
  const originalFetch = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/chunks/c2')) return new Response('{坏行', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    return originalFetch(url, options);
  });
  const response = await collect(intakeBase, sourceBase);
  assert.equal(response.status, 207);
  const report = await response.json();
  assert.equal(report.chunks[0].status, 'accepted');
  assert.equal(report.chunks[1].status, 'rejected');
  assert.match(report.chunks[1].error, /JSON/);
});

test('同一原文重复采集复用版本，不产生重复事件', async context => {
  const { intakeBase, sourceBase } = await withServices(context);
  const first = await (await collect(intakeBase, sourceBase)).json();
  const second = await (await collect(intakeBase, sourceBase)).json();
  assert.equal(first.chunks[0].duplicate, false);
  assert.equal(second.chunks[0].duplicate, true);
  const events = await (await fetch(intakeBase + '/api/events')).json();
  assert.equal(events.length, 2);
});

test('来源不可达返回 502，查询支持按进程过滤', async context => {
  const { intakeBase } = await withServices(context);
  const bad = await collect(intakeBase, 'http://127.0.0.1:9');
  assert.equal(bad.status, 502);
  const filtered = await (await fetch(intakeBase + '/api/events?processId=app-1')).json();
  assert.ok(Array.isArray(filtered));
});

test('不同进程恰好相同的常量编号不串用定义', async context => {
  const { intakeBase } = await withServices(context);
  const listing = [
    { chunkId: 'cx', processId: 'app-1', href: '/chunks/cx', sealed: true, ticksPerSecond: 1000, startTicks: 0, startTime: '2026-11-01T00:00:00Z' },
    { chunkId: 'cx', processId: 'app-2', href: '/chunks/cx', sealed: true, ticksPerSecond: 1000, startTicks: 0, startTime: '2026-11-01T00:00:00Z' },
  ];
  const block = (threadName) => [
    { type: 'metadata', types: { operation: ['thread', 'ticks'] } },
    { type: 'event', id: 'e1', eventType: 'operation', thread: 1, ticks: 1 },
    { type: 'constant', id: 1, kind: 'thread', value: threadName },
    { type: 'checkpoint', previous: null, complete: true },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  const originalFetch = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const href = String(url);
    if (!href.startsWith('http://source.test')) return originalFetch(url, options);
    if (href.endsWith('/recordings/r1/chunks')) return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } });
    if (href.endsWith('/chunks/cx')) {
      // 两个进程的响应无法从 URL 区分，靠清单顺序与各自建模上下文隔离
      fetchCounter.value += 1;
      return new Response(block(fetchCounter.value === 1 ? '甲馆线程' : '乙馆线程'), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    return originalFetch(url, options);
  });
  const fetchCounter = { value: 0 };
  const response = await collect(intakeBase, 'http://source.test');
  assert.equal(response.status, 201);
  const events = await (await fetch(intakeBase + '/api/events?chunkId=cx')).json();
  assert.deepEqual(events.map(item => [item.processId, item.event.references.thread.value]), [['app-1', '甲馆线程'], ['app-2', '乙馆线程']]);
});

test('原始字节按摘要归档且可凭事件回执回溯', async context => {
  const { intakeBase, sourceBase } = await withServices(context);
  await collect(intakeBase, sourceBase);
  const events = await (await fetch(intakeBase + '/api/events?chunkId=c1&eventId=e1')).json();
  const chunks = await (await fetch(intakeBase + '/api/chunks?chunkId=c1')).json();
  assert.equal(events.length, 1);
  assert.equal(events[0].receipt, chunks[0].receipt);
  const records = await (await fetch(intakeBase + '/api/records')).json();
  const recording = records.find(item => item.source === 'recording'
    && item.versions[0].data.identity.processId === 'app-1'
    && item.versions[0].data.identity.chunkId === 'c1');
  assert.equal(recording.versions[0].data.rawSha256, chunks[0].rawSha256);
  assert.match(chunks[0].rawSha256, /^[0-9a-f]{64}$/);
});
