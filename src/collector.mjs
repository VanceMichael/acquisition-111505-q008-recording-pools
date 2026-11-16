// 自动采集编排：从录制网关拉取块清单与 NDJSON 字节，解析建模后进入同一归档。
// 原始字节、常量定义、时钟依据与事件一起落档，查询事件时可以回到其原始块。
import { readFile } from 'node:fs/promises';
import { digest } from './archive.mjs';
import { request } from './transport.mjs';
import { parseNdjson, buildChunkModel } from './recording.mjs';

const configuration = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));

export class SourceError extends Error {}

function sourceUrl(base, probe) {
  let url;
  try { url = new URL(probe, base); } catch { throw new SourceError('来源地址无效'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SourceError('仅支持 http/https 来源');
  return url;
}

// 清单里的相对链接必须按实际来源地址解释，不能假定来源路径布局。
function chunkUrl(listing, entry) {
  if (typeof entry.href !== 'string' || !entry.href) throw new SourceError(`块 ${entry.chunkId ?? '?'} 缺少 href`);
  try { return new URL(entry.href, listing.url); } catch { throw new SourceError(`块 ${entry.chunkId} 的 href 无效`); }
}

export async function collectRecording(archive, { source, probe = configuration.probe } = {}) {
  if (typeof source !== 'string' || !source) throw new SourceError('缺少来源地址');
  const listingUrl = sourceUrl(source, probe);
  let listingReply;
  try {
    listingReply = await request(listingUrl.href);
  } catch (error) {
    throw new SourceError(`无法连接来源：${error.message}`);
  }
  if (listingReply.status < 200 || listingReply.status > 299) throw new SourceError(`来源清单返回 ${listingReply.status}`);
  let listing;
  try { listing = JSON.parse(listingReply.bytes.toString('utf8')); } catch { throw new SourceError('来源清单不是有效 JSON'); }
  if (!Array.isArray(listing) || listing.length === 0) throw new SourceError('来源清单为空或格式无效');

  const chunks = [];
  for (const entry of listing) {
    if (!entry || typeof entry !== 'object' || typeof entry.chunkId !== 'string' || typeof entry.processId !== 'string') {
      throw new SourceError('块清单条目缺少 chunkId/processId');
    }
    const url = chunkUrl({ url: listingUrl }, entry);
    const outcome = { chunkId: entry.chunkId, processId: entry.processId, href: url.href };
    try {
      const reply = await request(url.href);
      if (reply.status < 200 || reply.status > 299) throw new SourceError(`块字节返回 ${reply.status}`);
      const text = reply.bytes.toString('utf8');
      const { records, tailGap } = parseNdjson(text, { sealed: entry.sealed });
      const model = buildChunkModel({ chunk: entry, records, tailGap });
      const identity = { ...model.identity, source: 'recording' };
      const data = {
        ...model,
        source: 'recording',
        rawSha256: digest(reply.bytes),
        fetchedFrom: url.href,
        eventCount: model.events.length,
      };
      const receipt = await archive.accept('recording', identity, data, reply.bytes);
      chunks.push({ ...outcome, status: 'accepted', sealed: model.chunk.sealed, complete: model.complete, tailGap, ...receipt, eventCount: model.events.length });
    } catch (error) {
      // 单块失败（含未封口块的可接收情形之外的错误）不抹掉其他块，失败原因如实返回。
      chunks.push({ ...outcome, status: 'rejected', error: error.message, sealed: entry.sealed === true });
    }
  }
  return { source: listingUrl.origin, probe: listingUrl.pathname, collectedAt: new Date().toISOString(), chunks };
}

// 事件视图扁平化自块归档；每条事件都带 processId/chunkId/receipt/常量与时钟依据，
// 不同进程相同编号因 processId 维度天然隔离。返回顺序按进程、块、块内行号确定。
export async function listEvents(archive, filters = {}) {
  const receipts = await archive.list();
  const events = [];
  for (const receipt of receipts) {
    if (receipt.source !== 'recording') continue;
    for (const version of receipt.versions) {
      if (filters.version && version.version !== Number(filters.version)) continue;
      const data = version.data;
      if (filters.processId && data.identity.processId !== filters.processId) continue;
      if (filters.chunkId && data.identity.chunkId !== filters.chunkId) continue;
      for (const event of data.events) {
        if (filters.eventId && event.id !== filters.eventId) continue;
        events.push({
          receipt: receipt.receipt,
          version: version.version,
          processId: data.identity.processId,
          chunkId: data.identity.chunkId,
          chunkComplete: data.complete,
          chunkSealed: data.chunk.sealed,
          tailGap: data.tailGap,
          event,
        });
      }
    }
  }
  return events.sort((a, b) =>
    a.processId.localeCompare(b.processId)
    || a.chunkId.localeCompare(b.chunkId)
    || a.event.lineIndex - b.event.lineIndex
    || a.event.id.localeCompare(b.event.id));
}

export async function listChunkReceipts(archive, filters = {}) {
  const receipts = await archive.list();
  const view = [];
  for (const receipt of receipts) {
    if (receipt.source !== 'recording') continue;
    for (const version of receipt.versions) {
      if (filters.version && version.version !== Number(filters.version)) continue;
      const data = version.data;
      if (filters.processId && data.identity.processId !== filters.processId) continue;
      if (filters.chunkId && data.identity.chunkId !== filters.chunkId) continue;
      view.push({
        receipt: receipt.receipt,
        version: version.version,
        processId: data.identity.processId,
        chunkId: data.identity.chunkId,
        sealed: data.chunk.sealed,
        complete: data.complete,
        tailGap: data.tailGap,
        rawSha256: data.rawSha256,
        fetchedFrom: data.fetchedFrom,
        clockBasis: { startTicks: data.chunk.startTicks, ticksPerSecond: data.chunk.ticksPerSecond, startTime: data.chunk.startTime },
        constants: data.constants,
        checkpoints: data.checkpoints,
        eventCount: data.eventCount,
      });
    }
  }
  return view;
}
