// 录制块（NDJSON）的纯解析与常量引用建模，不依赖 HTTP 或文件系统。
// 常量编号仅在 processId/chunkId 作用域内有效，且允许前向引用（定义可以出现在事件之后），
// 因此先完整收集块内记录，再统一解析引用；未解析的引用保留编号并显式标注，绝不回填空字符串。

export class RecordingError extends Error {}

const CLOCK_FIELD = 'ticks';
const KINDS_WITH_STRING = new Set(['thread', 'method']);

// 把块文本拆成记录。sealed=false 的末块允许最后一行停在未封口的半截记录上，
// 此时返回 tailGap 说明缺口位置；其他任何坏行都拒绝，避免把缺口误当成“没有事件”。
export function parseNdjson(text, { sealed }) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const records = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') throw new RecordingError(`第 ${index + 1} 行不是有效记录`);
    try {
      const record = JSON.parse(trimmed);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new RecordingError('记录应是对象');
      records.push(record);
    } catch (error) {
      const isTailGap = index === lines.length - 1 && sealed !== true;
      if (!isTailGap) throw new RecordingError(`第 ${index + 1} 行 JSON 无效：${error.message}`);
      return { records, tailGap: { lineNumber: index + 1, partialBytes: line.length } };
    }
  }
  return { records, tailGap: null };
}

function assertInteger(value, label) {
  if (!Number.isInteger(value)) throw new RecordingError(`${label} 必须是整数编号`);
}

// 引用树中是否仍有未解析节点（未解析节点带 status:'unresolved'，而不是空字符串）。
export function containsUnresolved(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.status === 'unresolved') return true;
  return Object.values(node).some(value => {
    if (Array.isArray(value)) return value.some(containsUnresolved);
    return value && typeof value === 'object' && containsUnresolved(value);
  });
}

// 时钟换算：同时给出原始 ticks、换算依据和墙钟时间，分数毫秒保留，不丢失换算过程。
export function convertClock(ticks, basis) {
  const { startTicks, ticksPerSecond, startTime } = basis;
  if (Number.isNaN(new Date(startTime).getTime())) throw new RecordingError('startTime 不是有效时间');
  const offsetMilliseconds = ((ticks - startTicks) * 1000) / ticksPerSecond;
  return {
    ticks,
    startTicks,
    ticksPerSecond,
    startTime,
    offsetMilliseconds,
    wallTime: new Date(new Date(startTime).getTime() + offsetMilliseconds).toISOString(),
  };
}

// 依据清单元数据与块内记录构建块模型。chunk 携带 processId/chunkId 与时钟基准，
// 保证不同进程里恰好相同的常量编号也不会共用定义。
export function buildChunkModel({ chunk, records, tailGap }) {
  for (const field of ['chunkId', 'processId']) {
    if (typeof chunk[field] !== 'string' || !chunk[field]) throw new RecordingError(`块元数据缺少 ${field}`);
  }
  const basis = {
    startTicks: chunk.startTicks,
    ticksPerSecond: chunk.ticksPerSecond,
    startTime: chunk.startTime,
  };
  if (!Number.isInteger(basis.startTicks)) throw new RecordingError('块元数据缺少整数 startTicks');
  if (!Number.isInteger(basis.ticksPerSecond) || basis.ticksPerSecond <= 0) throw new RecordingError('块元数据缺少正整数 ticksPerSecond');
  if (Number.isNaN(new Date(basis.startTime).getTime())) throw new RecordingError('块元数据 startTime 无效');

  const constants = new Map();
  const events = [];
  const checkpoints = [];
  const typeFields = new Map();

  for (const [lineIndex, record] of records.entries()) {
    const at = `第 ${lineIndex + 1} 行`;
    if (record.type === 'metadata') {
      if (!record.types || typeof record.types !== 'object' || Array.isArray(record.types)) throw new RecordingError(`${at} metadata 缺少 types`);
      for (const [eventType, fields] of Object.entries(record.types)) {
        if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')) throw new RecordingError(`${at} metadata.types.${eventType} 必须是字段名数组`);
        if (typeFields.has(eventType)) throw new RecordingError(`${at} 事件类型 ${eventType} 的 metadata 重复声明`);
        typeFields.set(eventType, fields);
      }
    } else if (record.type === 'constant') {
      assertInteger(record.id, `${at} 常量 id`);
      if (typeof record.kind !== 'string' || !record.kind) throw new RecordingError(`${at} 常量 ${record.id} 缺少 kind`);
      const key = String(record.id);
      if (constants.has(key)) throw new RecordingError(`${at} 常量编号 ${record.id} 在同一块内重复定义`);
      if (KINDS_WITH_STRING.has(record.kind) && typeof record.value !== 'string') throw new RecordingError(`${at} 常量 ${record.id}(${record.kind}) 缺少字符串 value`);
      if (record.kind === 'stack' && (!Array.isArray(record.frames) || record.frames.some(id => !Number.isInteger(id)))) throw new RecordingError(`${at} 栈常量 ${record.id} 的 frames 必须是整数编号数组`);
      if (record.kind === 'frame' && !Number.isInteger(record.method)) throw new RecordingError(`${at} 帧常量 ${record.id} 缺少 method 编号`);
      constants.set(key, { raw: { ...record }, lineIndex });
    } else if (record.type === 'event') {
      if (typeof record.id !== 'string' || !record.id) throw new RecordingError(`${at} 事件缺少字符串 id`);
      if (events.some(item => item.raw.id === record.id)) throw new RecordingError(`${at} 事件编号 ${record.id} 在同一块内重复`);
      const fields = typeFields.get(record.eventType);
      if (!fields) throw new RecordingError(`${at} 事件 ${record.id} 的类型 ${record.eventType} 没有 metadata 声明`);
      if (!Number.isInteger(record.ticks) || record.ticks < 0) throw new RecordingError(`${at} 事件 ${record.id} 缺少非负整数 ticks`);
      for (const field of fields) {
        if (field === CLOCK_FIELD) continue;
        if (!Number.isInteger(record[field])) throw new RecordingError(`${at} 事件 ${record.id} 的引用字段 ${field} 必须是整数常量编号`);
      }
      events.push({ raw: { ...record }, lineIndex });
    } else if (record.type === 'checkpoint') {
      checkpoints.push({ raw: { ...record }, lineIndex });
    } else {
      throw new RecordingError(`${at} 出现未知记录类型 ${String(record.type)}`);
    }
  }

  const describe = (id, expectedKind, path) => {
    const entry = constants.get(String(id));
    if (!entry) return { status: 'unresolved', id, expectedKind: expectedKind ?? null, path, reason: 'constant-not-found' };
    if (expectedKind && entry.raw.kind !== expectedKind) return { status: 'unresolved', id, expectedKind, path, reason: `kind-mismatch:${entry.raw.kind}` };
    const node = { status: 'resolved', id, kind: entry.raw.kind, path, lineIndex: entry.lineIndex };
    if (KINDS_WITH_STRING.has(entry.raw.kind)) node.value = entry.raw.value;
    if (entry.raw.kind === 'frame') node.method = describe(entry.raw.method, 'method', `${path}/method`);
    if (entry.raw.kind === 'stack') node.frames = entry.raw.frames.map((frameId, index) => describe(frameId, 'frame', `${path}/frames/${index}`));
    return node;
  };

  const resolvedEvents = events.map(({ raw, lineIndex }) => {
    const references = {};
    for (const field of typeFields.get(raw.eventType)) {
      if (field === CLOCK_FIELD) continue;
      const expectedKind = field === 'thread' ? 'thread' : field === 'stack' ? 'stack' : undefined;
      references[field] = describe(raw[field], expectedKind, `event/${field}`);
    }
    return {
      id: raw.id,
      lineIndex,
      raw,
      references,
      unresolved: containsUnresolved(references),
      clock: convertClock(raw.ticks, basis),
    };
  });

  const lastCheckpoint = checkpoints.at(-1)?.raw ?? null;
  const complete = chunk.sealed === true && tailGap === null && lastCheckpoint?.complete === true;

  return {
    identity: { processId: chunk.processId, chunkId: chunk.chunkId },
    chunk: {
      processId: chunk.processId,
      chunkId: chunk.chunkId,
      sealed: chunk.sealed === true,
      ticksPerSecond: basis.ticksPerSecond,
      startTicks: basis.startTicks,
      startTime: basis.startTime,
    },
    constants: [...constants.values()].map(entry => ({ ...entry.raw, lineIndex: entry.lineIndex })),
    events: resolvedEvents,
    checkpoints: checkpoints.map(entry => ({ ...entry.raw, lineIndex: entry.lineIndex })),
    tailGap,
    complete,
  };
}
