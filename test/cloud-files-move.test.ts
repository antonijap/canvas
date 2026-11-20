import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PLAYGROUND } from '../qa/playground.ts';
import { ROOT, startServer } from '../qa/lib.ts';
import { expectedMove } from '../qa/cloud-files-fixture.ts';

test('Cloud moves preserve complete packages byte for byte after JSON serialization', async t => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-move-roundtrip-')));
    const server = await startServer(dir, {
        HOME: dir,
        CANVAS_STATE_DIR: path.join(dir, 'state'),
        CANVAS_CLOUD_SECRETS_FILE: path.join(dir, 'secrets.json'),
        CANVAS_TUNNEL_BIN: path.join(ROOT, 'test/fixtures/fake-tunnel.sh'),
        CANVAS_FAKE_TUNNEL_DIR: path.join(dir, 'tunnels'),
        CANVAS_FAKE_TUNNEL_NODE: process.execPath,
        CANVAS_FAKE_TUNNEL_ANY_PORT: '1',
        CANVAS_COMMENT_NAME: 'Editor',
    });
    const call = async (route: string, body: unknown) => {
        const response = await fetch(server.base + route, {
            method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const result = await response.json() as any;
        assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
        return result;
    };
    try {
        fs.mkdirSync(path.join(dir, 'tunnels'), { recursive: true });
        for (const fixture of ['playground', 'media', 'empty variables', 'children first']) {
            await t.test(fixture, async () => {
                const host = await call('/api/cloud/host/start', { name: 'Studio', label: 'Editor' });
                const source = path.join(dir, fixture + '.canvas');
                if (fixture === 'playground') fs.cpSync(PLAYGROUND, source, { recursive: true });
                else {
                    fs.mkdirSync(source);
                    const doc = fixture === 'children first' ? { children: [], version: '2.21' } : {
                        version: '2.21',
                        themes: { mode: ['light', 'dark'] },
                        variables: fixture === 'empty variables' ? {} : { accent: { type: 'color', value: '#123456' } },
                        fonts: [],
                        children: [{
                            type: 'frame', id: 'Board', width: 200, height: 200,
                            children: Array.from({ length: 130 }, (_, i) => ({
                                id: 'Item' + i, type: 'rectangle', width: 1, height: 1,
                                fill: { type: 'image', url: 'media/image.png' },
                            })),
                        }, { id: 'Empty', type: 'frame', children: [] }],
                    };
                    fs.writeFileSync(path.join(source, 'document.json'), JSON.stringify(doc));
                    fs.mkdirSync(path.join(source, 'media'));
                    fs.mkdirSync(path.join(source, 'shaders'));
                    fs.writeFileSync(path.join(source, 'media/image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64'));
                    const video = fs.readdirSync(path.join(PLAYGROUND, 'media')).find(name => name.endsWith('.mp4'))!;
                    fs.copyFileSync(path.join(PLAYGROUND, 'media', video), path.join(source, 'media/clip.mp4'));
                    fs.writeFileSync(path.join(source, 'shaders/Shader.src-123456789abc.wgsl'), 'fn shade(p:vec2<f32>)->vec4<f32>{return vec4<f32>(p,0.,1.);}');
                    fs.writeFileSync(path.join(source, 'widgets.json'), JSON.stringify({ widgets: [
                        { id: 'Video', kind: 'video', name: 'Video', x: 0, y: 0, w: 100, h: 100, locked: false, config: { src: 'media/clip.mp4' } },
                        { id: 'Shader', kind: 'shader', name: 'Shader', x: 120, y: 0, w: 100, h: 100, locked: false, config: { rev: '123456789abc' } },
                        { id: 'Note', kind: 'note', name: 'Note', x: 0, y: 120, w: 100, h: 100, locked: false, config: { text: 'Example' } },
                    ], pages: [
                        { id: 'first', name: 'First', boards: fixture === 'children first' ? [] : ['Board'] },
                        { id: 'second', name: 'Second', boards: fixture === 'children first' ? [] : ['Empty'] },
                        { id: 'third', name: 'Third', boards: [] },
                    ] }));
                }
                const { document, images } = expectedMove(source);
                const envelope = JSON.parse(fs.readFileSync(path.join(source, 'widgets.json'), 'utf8'));
                const assets = ['media', 'shaders'].flatMap(folder => fs.readdirSync(path.join(source, folder))
                    .filter(name => fs.statSync(path.join(source, folder, name)).isFile() && !name.includes('.poster-'))
                    .map(name => ({ rel: folder + '/' + name, bytes: fs.readFileSync(path.join(source, folder, name)) })));
                const moved = await call('/api/cloud/files/move?file=' + encodeURIComponent(source), { cloud: host.url });
                assert.equal(moved.verified, true);
                assert.equal(fs.existsSync(source), false);
                const check = (file: string) => {
                    assert.equal(fs.readFileSync(path.join(file, 'document.json'), 'utf8'), document);
                    const actual = JSON.parse(fs.readFileSync(path.join(file, 'widgets.json'), 'utf8'));
                    for (const key of Object.keys(envelope).filter(key => key !== 'version'))
                        assert.equal(JSON.stringify(actual[key]), JSON.stringify(envelope[key]), key);
                    for (const asset of [...assets, ...images]) assert.deepEqual(fs.readFileSync(path.join(file, asset.rel)), asset.bytes, asset.rel);
                };
                check(moved.file);
                await call('/api/cloud/files/close', { file: moved.file });
                // Discard the cache so reopening must download the room's persisted snapshot and assets.
                fs.rmSync(moved.file, { recursive: true });
                const reopened = await call('/api/cloud/files/open', { cloud: host.url, id: moved.id });
                check(reopened.file);
            });
        }
    } finally {
        await server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
