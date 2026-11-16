import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingError, parseNdjson, buildChunkModel, convertClock, containsUnresolved } from '../src/recording.mjs';

const baseChunk = {
  chunkId: 'c1', processId: 'app-1', sealed: true,
  ticksPerSecond: 1000, startTicks: 0, startTime: '2026-11-01T00:00:00Z',
};
const rows = {
  metadata: { type: 'metadata', types: { operation: ['thread', 'stack', 'ticks'] } },
  event: { type: 'event', id: 'e1', eventType: 'operation', thread: 1, stack: 2, ticks: 500 },
  thread: { type: 'constant', id: 1, kind: 'thread', value: '接待线程' },
  stack: { type: 'constant', id: 2, kind: 'stack', frames: [3] },
  frame: { type: 'constant', id: 3, kind: 'frame', method: 4 },
  method: { type: 'constant', id: 4, kind: 'method', value: 'receive' },
  checkpoint: { type: 'checkpoint', previous: null, complete: true },
};
const ndjson = list => list.map(row => JSON.stringify(row)).join('\n') + '\n';

function model(records, chunk = baseChunk) {
  return buildChunkModel({ chunk, records, tailGap: null });
}

test('常量定义出现在事件之后仍可解析完整引用树', () => {
  const { records } = parseNdjson(ndjson([rows.metadata, rows.event, rows.thread, rows.stack, rows.frame, rows.method, rows.checkpoint]), { sealed: true });
  const result = model(records);
  assert.equal(result.complete, true);
  const [event] = result.events;
  assert.equal(event.unresolved, false);
  assert.equal(event.references.thread.value, '接待线程');
  assert.equal(event.references.stack.frames[0].method.value, 'receive');
});

test('不同块相同常量编号不共享定义', () => {
  const first = model(parseNdjson(ndjson([rows.metadata, rows.event, rows.thread, rows.stack, rows.frame, rows.method, rows.checkpoint]), { sealed: true }).records);
  const second = model(
    parseNdjson(ndjson([rows.metadata, rows.event, { ...rows.thread, value: '装箱线程' }, rows.stack, rows.frame, rows.method, rows.checkpoint]), { sealed: true }).records,
    { ...baseChunk, chunkId: 'c2', ticksPerSecond: 2000 },
  );
  assert.equal(first.events[0].references.thread.value, '接待线程');
  assert.equal(second.events[0].references.thread.value, '装箱线程');
  assert.equal(second.events[0].clock.ticksPerSecond, 2000);
});

test('时钟换算保留原始 ticks 与依据并给出墙钟时间', () => {
  const clock = convertClock(1500, { startTicks: 1000, ticksPerSecond: 2000, startTime: '2026-11-01T00:00:00Z' });
  assert.equal(clock.offsetMilliseconds, 250);
  assert.equal(clock.wallTime, '2026-11-01T00:00:00.250Z');
  const fractional = convertClock(1, { startTicks: 0, ticksPerSecond: 2000, startTime: '2026-11-01T00:00:00Z' });
  assert.equal(fractional.offsetMilliseconds, 0.5);
});

test('缺失的常量定义保留编号并显式标注而非回填空字符串', () => {
  const { records } = parseNdjson(ndjson([rows.metadata, rows.event, rows.thread, rows.stack, rows.checkpoint]), { sealed: true });
  const result = model(records, { ...baseChunk, sealed: false });
  const [event] = result.events;
  assert.equal(event.unresolved, true);
  assert.equal(event.references.stack.frames[0].status, 'unresolved');
  assert.equal(event.references.stack.frames[0].id, 3);
  assert.equal(event.references.stack.frames[0].value, undefined);
  assert.equal(event.references.thread.status, 'resolved');
  assert.equal(containsUnresolved(event.references), true);
});

test('未封口末块的尾部缺口可识别且不把缺口当成没有事件', () => {
  const full = ndjson([rows.metadata, rows.event, rows.thread, rows.stack, rows.frame, rows.method, rows.checkpoint]);
  const truncated = full.slice(0, -20);
  const parsed = parseNdjson(truncated, { sealed: false });
  assert.ok(parsed.tailGap);
  const result = buildChunkModel({ chunk: { ...baseChunk, sealed: false }, records: parsed.records, tailGap: parsed.tailGap });
  assert.equal(result.events.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.tailGap.lineNumber, parsed.records.length + 1);
});

test('已封口块出现坏行必须拒绝', () => {
  assert.throws(() => parseNdjson(ndjson([rows.metadata, rows.event]).replace('"event"', '"evint"').slice(0, -1) + 'x', { sealed: true }), RecordingError);
  assert.throws(() => parseNdjson('{"type":"metadata","types":{}}\n\n', { sealed: true }), RecordingError);
});

test('常量编号重复、类型不符与未知记录类型均被拒绝', () => {
  const dup = [rows.metadata, rows.event, rows.thread, rows.thread, rows.stack, rows.frame, rows.method, rows.checkpoint];
  assert.throws(() => model(parseNdjson(ndjson(dup), { sealed: true }).records), /重复定义/);
  const mismatch = [rows.metadata, { ...rows.event, thread: 2 }, rows.thread, rows.stack, rows.frame, rows.method, rows.checkpoint];
  const result = model(parseNdjson(ndjson(mismatch), { sealed: true }).records);
  assert.equal(result.events[0].references.thread.status, 'unresolved');
  assert.match(result.events[0].references.thread.reason, /kind-mismatch/);
  assert.throws(() => model(parseNdjson(ndjson([rows.metadata, { type: 'rogue' }]), { sealed: true }).records), /未知记录类型/);
});

test('缺少封口 checkpoint 的块不算完整', () => {
  const result = model(parseNdjson(ndjson([rows.metadata, rows.event, rows.thread, rows.stack, rows.frame, rows.method]), { sealed: true }).records);
  assert.equal(result.complete, false);
  assert.equal(result.events.length, 1);
});
