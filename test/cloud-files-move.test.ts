import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PLAYGROUND } from '../qa/playground.ts';
import { ROOT, startServer } from '../qa/lib.ts';
import { expectedMove } from '../qa/cloud-files-fixture.ts';
import { NIL_DOC } from '../src/cloud-sync.ts';
import { readCommentsFile } from '../src/comments-file.ts';

test('Cloud moves preserve complete packages byte for byte after JSON serialization', async t => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-move-roundtrip-')));
    const server = await startServer(dir, {
        HOME: dir,
        CANVAS_HEADLESS: '1',
        CANVAS_CLOUD_HOST_PORT: '0',
        CANVAS_STATE_DIR: path.join(dir, 'state'),
        CANVAS_CLOUD_SECRETS_FILE: path.join(dir, 'secrets.json'),
        CANVAS_TUNNEL_BIN: path.join(ROOT, 'test/fixtures/fake-tunnel.sh'),
        CANVAS_FAKE_TUNNEL_DIR: path.join(dir, 'tunnels'),
        CANVAS_FAKE_TUNNEL_NODE: process.execPath,
        CANVAS_FAKE_TUNNEL_ANY_PORT: '1',
        CANVAS_COMMENT_NAME: 'Editor',
    });
    const call = async (route: string, body: unknown, expectedStatus?: number) => {
        const response = await fetch(server.base + route, {
            method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const result = await response.json() as any;
        if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, JSON.stringify(result));
        else assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
        return result;
    };
    try {
        fs.mkdirSync(path.join(dir, 'tunnels'), { recursive: true });
        for (const fixture of ['playground', 'media', 'empty variables', 'children first', 'package image folder']) {
            await t.test(fixture, async () => {
                const host = await call('/api/cloud/host/start', { name: 'Studio', label: 'Editor' });
                const source = path.join(dir, fixture + '.canvas');
                if (fixture === 'playground') fs.cpSync(PLAYGROUND, source, { recursive: true });
                else {
                    fs.mkdirSync(source);
                    const imagePath = fixture === 'package image folder' ? 'assets/pictures/image.png' : 'media/image.png';
                    const doc = fixture === 'children first' ? { children: [], version: '2.21' } : {
                        version: '2.21',
                        themes: { mode: ['light', 'dark'] },
                        variables: fixture === 'empty variables' ? {} : { accent: { type: 'color', value: '#123456' } },
                        fonts: [],
                        children: [{
                            type: 'frame', id: 'Board', width: 200, height: 200,
                            children: Array.from({ length: 130 }, (_, i) => ({
                                id: 'Item' + i, type: 'rectangle', width: 1, height: 1,
                                fill: { type: 'image', url: imagePath },
                            })),
                        }, { id: 'Empty', type: 'frame', children: [] }],
                    };
                    fs.writeFileSync(path.join(source, 'document.json'), JSON.stringify(doc));
                    fs.mkdirSync(path.join(source, 'media'));
                    fs.mkdirSync(path.join(source, 'shaders'));
                    fs.writeFileSync(path.join(source, 'media/image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64'));
                    if (fixture === 'package image folder') {
                        fs.mkdirSync(path.dirname(path.join(source, imagePath)), { recursive: true });
                        fs.copyFileSync(path.join(source, 'media/image.png'), path.join(source, imagePath));
                    }
                    const video = fs.readdirSync(path.join(PLAYGROUND, 'media')).find(name => name.endsWith('.mp4'))!;
                    fs.copyFileSync(path.join(PLAYGROUND, 'media', video), path.join(source, 'media/clip.mp4'));
                    fs.writeFileSync(path.join(source, 'shaders/Shader.src-123456789abc.wgsl'), 'fn shade(p:vec2<f32>)->vec4<f32>{return vec4<f32>(p,0.,1.);}');
                    fs.writeFileSync(path.join(source, 'widgets.json'), JSON.stringify({ widgets: [
                        { id: 'Video', kind: 'video', name: 'Video', x: 0, y: 0, w: 100, h: 100, locked: false, config: { src: 'media/clip.mp4' } },
                        { id: 'Shader', kind: 'shader', name: 'Shader', x: 120, y: 0, w: 100, h: 100, locked: false, config: { rev: '123456789abc' } },
                        { id: 'Note', kind: 'note', name: 'Note', x: 0, y: 120, w: 100, h: 100, locked: false, config: { text: 'Example' } },
                    ], pages: [
                        fixture === 'children first'
                            ? { id: 'first', name: 'First', boards: [], background: '#123ABC', pattern: { kind: 'blueprint', spacing: 8, major: 4, opacity: 30 } }
                            : { id: 'first', name: 'First', boards: ['Board'] },
                        { id: 'second', name: 'Second', boards: fixture === 'children first' ? [] : ['Empty'] },
                        { id: 'third', name: 'Third', boards: [] },
                    ] }));
                }
                let { document, images } = expectedMove(source);
                if (fixture === 'package image folder') {
                    const bytes = fs.readFileSync(path.join(source, 'assets/pictures/image.png'));
                    const rel = `media/${createHash('sha256').update(bytes).digest('hex')}.png`;
                    document = document.replaceAll('assets/pictures/image.png', rel);
                    images.push({ rel, bytes });
                }
                const envelope = JSON.parse(fs.readFileSync(path.join(source, 'widgets.json'), 'utf8'));
                if (fixture === 'children first') {
                    delete envelope.pages[0].background;
                    delete envelope.pages[0].pattern;
                }
                const assets = ['media', 'shaders'].flatMap(folder => fs.readdirSync(path.join(source, folder))
                    .filter(name => fs.statSync(path.join(source, folder, name)).isFile() && !name.includes('.poster-'))
                    .map(name => ({ rel: folder + '/' + name, bytes: fs.readFileSync(path.join(source, folder, name)) })));
                const vote = randomUUID();
                const envelopeFor = (op: object) => ({ opId: randomUUID(), doc: NIL_DOC, at: new Date().toISOString(), op });
                if (fixture === 'playground') {
                    const route = '/api/votes?file=' + encodeURIComponent(source);
                    await call(route, { name: 'Anna', envelope: envelopeFor({ kind: 'vote.start', vote, scope: { page: 'layout' }, on: 'anything', perPerson: 3, hidden: true, anonymous: false }) });
                    await call(route, { name: 'Anna', envelope: envelopeFor({ kind: 'vote.cast', vote, ballot: randomUUID(), layer: 'r_free' }) });
                }
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
                if (fixture === 'playground') {
                    const before = readCommentsFile(moved.file)!;
                    assert.equal(before.votes?.[0].id, vote);
                    assert.equal(before.votes?.[0].ballots[0].voter.name, 'Anna');
                    assert.deepEqual(before.outbox.map(e => [e.doc, e.op.kind]), [[moved.id, 'vote.start'], [moved.id, 'vote.cast']]);
                    const reply = await fetch(server.base + '/api/comments/ops?file=' + encodeURIComponent(moved.file), {
                        method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json', 'x-canvas-source': 'mcp' },
                        body: JSON.stringify({ ops: [envelopeFor({ kind: 'thread.create', thread: randomUUID(), comment: randomUUID(), body: 'Review this frame', anchor: { nodeId: 'lay_nest', x: 0.5, y: 0.5 } })] }),
                    });
                    assert.equal(reply.status, 200);
                    assert.deepEqual(readCommentsFile(moved.file)?.votes, before.votes);
                }
                if (fixture === 'children first') {
                    const health = await (await fetch(server.base + '/health')).json() as { version: string };
                    const client = new Client({ name: 'page-background-test', version: '1' });
                    try {
                        await client.connect(new StdioClientTransport({
                            command: process.execPath, args: [path.join(ROOT, 'mcp/server.ts')], stderr: 'pipe',
                            env: { CANVAS_PORT: String(server.port), CANVAS_MCP_BACKGROUND: '1', CANVAS_MCP_NO_SPAWN: '1', CANVAS_MCP_WANT_VERSION: health.version },
                        }));
                        for (const color of ['#456DEF', null]) {
                            const result = await client.callTool({ name: 'set_page_background', arguments: { file: moved.file, page: 'first', color } });
                            assert.equal(result.isError, true);
                            assert.match(JSON.stringify(result.content), /Page colours stay on local files for now/);
                        }
                        for (const pattern of [{ kind: 'blueprint', spacing: 8, major: 4, opacity: 30 }, null]) {
                            const result = await client.callTool({ name: 'set_page_pattern', arguments: { file: moved.file, page: 'first', pattern } });
                            assert.equal(result.isError, true);
                            assert.match(JSON.stringify(result.content), /Page colours stay on local files for now/);
                        }
                        check(moved.file);
                    } finally {
                        await client.close();
                    }
                }
                await call('/api/cloud/files/close', { file: moved.file });
                // Discard the cache so reopening must download the room's persisted snapshot and assets.
                fs.rmSync(moved.file, { recursive: true });
                const reopened = await call('/api/cloud/files/open', { cloud: host.url, id: moved.id });
                check(reopened.file);
                if (fixture === 'playground') {
                    const invalid = await call('/api/cloud/files/create', { cloud: host.url, name: 'Invalid manifest' });
                    const db = new DatabaseSync(path.join(dir, 'state', 'cloud-host', 'files', invalid.id + '.sqlite'));
                    try {
                        const { manifest } = db.prepare("SELECT manifest FROM snapshots WHERE seq=0").get() as { manifest: string };
                        const data = JSON.parse(manifest);
                        data.blobs = [{ path: '/media/fixture.png', sha256: 'a'.repeat(64), bytes: 1, type: 'image/png' }];
                        db.prepare('UPDATE snapshots SET manifest=? WHERE seq=0').run(JSON.stringify(data));
                    } finally { db.close(); }
                    const target = path.join(dir, 'Invalid.canvas');
                    const refusal = await call('/api/cloud/files/download', { cloud: host.url, id: invalid.id, target }, 400);
                    assert.match(refusal.error, /invalid blob path/);
                    assert.equal(fs.existsSync(target), false);
                }
                if (fixture === 'media') {
                    const renamed = await call('/api/cloud/files/rename', { cloud: host.url, id: moved.id, name: ' \u202eBo\u0000ard ' });
                    assert.equal(renamed.name, 'Board');
                    const duplicate = await call('/api/cloud/files/duplicate', { cloud: host.url, id: moved.id });
                    assert.equal(duplicate.name, 'Board copy');
                    const copy = await call('/api/cloud/files/open', { cloud: host.url, id: duplicate.id });
                    check(copy.file);
                    const target = path.join(dir, 'Download.canvas');
                    const downloaded = await call('/api/cloud/files/download', { cloud: host.url, id: duplicate.id, target });
                    assert.equal(downloaded.file, target);
                    assert.equal(fs.existsSync(path.join(target, '.cloud')), false);
                    check(target);
                    await call('/api/cloud/files/download', { cloud: host.url, id: moved.id, target }, 409);
                    check(target);
                    await call('/api/cloud/files/delete', { cloud: host.url, id: duplicate.id });
                    const list = await (await fetch(server.base + '/api/cloud/files?cloud=' + encodeURIComponent(host.url))).json() as { files: { id: string }[] };
                    assert.deepEqual(list.files.map(file => file.id), [moved.id]);
                }
            });
        }
        const rejectionHost = await call('/api/cloud/host/start', { name: 'Studio', label: 'Editor' });
        for (const code of ['invalid', 'forbidden']) await t.test(`move returns the host ${code} reason and keeps the source`, async () => {
            const source = path.join(dir, `Rejected-${code}.canvas`);
            fs.mkdirSync(source);
            const node = code === 'invalid' ? { id: 'Layer', type: 'unknown-kind' }
                : { id: 'Layer', type: 'rectangle', fill: { type: 'image', url: 'media/missing.png' } };
            const document = JSON.stringify({ version: '2.21', children: [node] });
            fs.writeFileSync(path.join(source, 'document.json'), document);
            const response = await fetch(server.base + '/api/cloud/files/move?file=' + encodeURIComponent(source), {
                method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cloud: rejectionHost.url }),
            });
            const result = await response.json() as any;
            assert.equal(response.status, 400);
            assert.equal(result.code, code);
            assert.ok(result.error.startsWith(`Cloud refused import (${code}): `));
            assert.match(result.error, code === 'invalid' ? /unknown-kind/ : /not a file of this design/);
            assert.ok(fs.readFileSync(path.join(dir, '.canvas-logs/server.log'), 'utf8').includes(result.error));
            assert.equal(fs.readFileSync(path.join(source, 'document.json'), 'utf8'), document);
        });
    } finally {
        await server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
