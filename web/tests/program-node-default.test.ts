import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

test('Program previews and sends use the displayed default node', async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    cacheDir: fileURLToPath(new URL('../.svelte-kit/test-cache-program', import.meta.url)),
    appType: 'custom',
    plugins: [svelte({ configFile: false })],
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { sequenceStore } = await vite.ssrLoadModule('/src/lib/sequence-store.svelte.ts');
    const { codecStore } = await vite.ssrLoadModule('/src/lib/codec-store.svelte.ts');
    const { busStore } = await vite.ssrLoadModule('/src/lib/bus-store.svelte.ts');
    const sent: number[] = [];
    busStore.client.status = 'connected';
    busStore.client.send = (id: number) => { sent.push(id); return true; };

    for (const { start, nodeId, expected } of [
      { start: 1, nodeId: undefined, expected: 0x401 },
      { start: 3, nodeId: undefined, expected: 0x403 },
      { start: 3, nodeId: '', expected: 0x403 },
      { start: 1, nodeId: 0, expected: 0x400 },
      { start: 1, nodeId: '=chosen_node', expected: 0x405 },
    ]) {
      codecStore.addConfig('nodes.yaml', `
device: {name: Nodes, fd: false}
messages:
  - name: Target
    id: 0x400
    dlc: 8
    node_count: 8
    node_id_offset: 1
    node_id_start: ${start}
    signals: []
`);
      const statement = { id: 'send', type: 'send', enabled: true, label: 'Target', msgName: 'Target', nodeId, values: {} };
      sequenceStore.ast = [
        { id: 'set', type: 'set', enabled: true, name: 'chosen_node', expr: '5' },
        statement,
      ];
      const preview = sequenceStore.encodeSendPreview(statement);
      assert.equal(preview.error, null);
      assert.equal(preview.frames[0].canId, expected, `preview: start=${start}, node=${nodeId}`);
      sent.length = 0;
      sequenceStore.start();
      // The runner walks this two-statement sequence asynchronously.
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(sent, [expected], `transmission: start=${start}, node=${nodeId}`);
      assert.equal(sequenceStore.running, false);
    }
  } finally {
    await vite.close();
  }
});
