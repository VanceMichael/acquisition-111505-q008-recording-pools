export const initialState = () => ({ name: '诊断录制交付', revision: 1 });

export async function handle({ url, state, json, bytes }) {
  if (url.pathname === '/recordings/r1/chunks') { json(200, ['c1', 'c2'].map((chunkId, index) => ({ chunkId, processId: 'app-1', href: `/chunks/${chunkId}`, sealed: index === 0 || !state.truncated, ticksPerSecond: index === 0 ? 1000 : 2000, startTicks: index * 1000, startTime: '2026-11-01T00:00:00Z' }))); return true; }
  if (url.pathname.startsWith('/chunks/')) {
    const chunk = url.pathname.split('/').at(-1);
    const rows = [{ type: 'metadata', types: { operation: ['thread', 'stack', 'ticks'] } },
      { type: 'event', id: 'e1', eventType: 'operation', thread: 1, stack: 2, ticks: 500 },
      { type: 'constant', id: 1, kind: 'thread', value: chunk === 'c1' ? '接待线程' : '装箱线程' },
      { type: 'constant', id: 2, kind: 'stack', frames: [3] },
      ...(state.unresolved ? [] : [{ type: 'constant', id: 3, kind: 'frame', method: 4 }, { type: 'constant', id: 4, kind: 'method', value: 'receive' }]),
      { type: 'checkpoint', previous: null, complete: true }];
    let text = rows.map(row => JSON.stringify(row)).join('\n') + '\n'; if (state.truncated && chunk === 'c2') text = text.slice(0, -20);
    bytes(200, text, 'application/x-ndjson'); return true;
  }
  return false;
}
