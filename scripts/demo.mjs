import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory);
const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;

  const run = async label => {
    const response = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
    const report = await response.json();
    console.log(`【${label}】HTTP ${response.status}`);
    for (const chunk of report.chunks) {
      console.log(JSON.stringify({ 块: chunk.chunkId, 进程: chunk.processId, 状态: chunk.status, 封口: chunk.sealed, 完整: chunk.complete, 尾部缺口: chunk.tailGap, 事件数: chunk.eventCount }));
    }
  };

  await run('情景一：两块完整，常量定义迟到');
  let events = await (await fetch(base + '/api/events')).json();
  for (const item of events) {
    console.log(JSON.stringify({
      事件: item.event.id, 进程: item.processId, 块: item.chunkId,
      线程: item.event.references.thread.value,
      堆栈: item.event.references.stack.frames.map(frame => frame.method?.value ?? `未解析#${frame.id}`),
      时钟: item.event.clock,
      回执: item.receipt,
    }));
  }

  await fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unresolved: true }) });
  await run('情景二：常量定义缺失，未解析引用保留编号');
  const unresolved = await (await fetch(base + '/api/events?chunkId=c1')).json();
  console.log(JSON.stringify({ 未解析节点: unresolved.at(-1).event.references.stack.frames[0] }));

  await fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unresolved: false, truncated: true }) });
  await run('情景三：末块停在未封口缺口');
  const allC2 = await (await fetch(base + '/api/chunks?chunkId=c2')).json();
  const latest = Math.max(...allC2.map(chunk => chunk.version));
  const tail = await (await fetch(base + `/api/chunks?chunkId=c2&version=${latest}`)).json();
  console.log(JSON.stringify({ 末块: tail.map(chunk => ({ chunkId: chunk.chunkId, complete: chunk.complete, tailGap: chunk.tailGap, eventCount: chunk.eventCount })) }));
} finally {
  intake.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
