import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { SourceError, collectRecording, listEvents, listChunkReceipts } from './collector.mjs';

const MAX_BODY_BYTES = 1048576;

async function readJsonBody(incoming) {
  const chunks = [];
  let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) return { error: { status: 413, message: '请求体过大' } };
    chunks.push(chunk);
  }
  if (chunks.length === 0) return { error: { status: 400, message: 'JSON 无效' } };
  try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { return { error: { status: 400, message: 'JSON 无效' } }; }
}

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      const url = new URL(incoming.url, 'http://localhost');
      if (incoming.method === 'GET' && incoming.url === '/health') return reply(200, { status: 'ok', acquisition: 'manual+recording' });
      if (incoming.method === 'GET' && incoming.url === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'POST' && incoming.url === '/api/collect') {
        const body = await readJsonBody(incoming);
        if (body.error) return reply(body.error.status, { error: body.error.message });
        try {
          const report = await collectRecording(archive, body.value ?? {});
          const rejected = report.chunks.some(chunk => chunk.status === 'rejected');
          return reply(rejected ? 207 : 201, report);
        } catch (error) {
          return reply(error instanceof SourceError ? 502 : 500, { error: error.message });
        }
      }
      if (incoming.method === 'GET' && url.pathname === '/api/events') {
        const filters = Object.fromEntries(['processId', 'chunkId', 'eventId', 'version'].map(key => [key, url.searchParams.get(key)]).filter(([, value]) => value));
        return reply(200, await listEvents(archive, filters));
      }
      if (incoming.method === 'GET' && url.pathname === '/api/chunks') {
        const filters = Object.fromEntries(['processId', 'chunkId', 'version'].map(key => [key, url.searchParams.get(key)]).filter(([, value]) => value));
        return reply(200, await listChunkReceipts(archive, filters));
      }
      if (incoming.method === 'POST' && incoming.url === '/api/manual') {
        const body = await readJsonBody(incoming);
        if (body.error) return reply(body.error.status, { error: body.error.message });
        try { return reply(201, await receiveManual(archive, body.value)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
