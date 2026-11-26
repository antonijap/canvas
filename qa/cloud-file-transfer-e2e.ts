// Run with node qa/cloud-file-transfer-e2e.ts. Set CANVAS_REAL_TUNNEL to test the bundled tunnel helper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { crc32, deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, startServer, type Scratch } from './lib.ts';
import { applyOp } from '../cloud/protocol.ts';
import { emptyComments } from '../src/comments-file.ts';
import { chromePath } from '../src/doc/render/chrome-path.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function png(index: number) {
    const chunk = (type: string, data: Buffer) => {
        const contents = Buffer.concat([Buffer.from(type), data]);
        const frame = Buffer.alloc(data.length + 12);
        frame.writeUInt32BE(data.length);
        contents.copy(frame, 4);
        frame.writeUInt32BE(crc32(contents), frame.length - 4);
        return frame;
    };
    const header = Buffer.from([0,0,0,2, 0,0,0,1, 8,2,0,0,0]);
    const pixels = Buffer.from([0, index >> 8, index & 255, 101, 235, 105, 65]);
    return Buffer.concat([
        Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
        chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
    ]);
}

// Generated two-glyph TrueType fixture with a single triangular letter A.
const font = Buffer.from(
    'AAEAAAAKAIAAAwAgT1MvMmDGXvMAAACsAAAATmNtYXAADAB0AAAA/AAAACxnbHlmc8DsWQAAASgAAAAeaGVhZGFuQ6EAAAFIAAAA' +
    'NmhoZWEFfAHDAAABgAAAACJobXR4BRQAAAAAAaQAAAAIbG9jYQAPAAAAAAGsAAAABm1heHAABAAFAAABtAAAACBuYW1lC9QbrAAA' +
    'AdQAAACqcG9zdP+4ADIAAAKAAAAAIAAAAooBkAAFAAACigKKAAAASwKKAooAAAFeADIA+gAAAAAAAAAAAAAAAAAAAAEAAAAAAAAA' +
    'AAAAAABURVNUAEAAQQBBAyD/OAAAAyAAyAAAAAAAAQADAAEAAAAMAAQAIAAAAAQABAABAAAAQf//AAAAQf///8AAAQAAAAAAAQAA' +
    'AAACWAK8AAIAAAEBAQAAASwBLAAAArz9RAAAAAABAAAAAQAADTdCRV8PPPUAAwPoAAAAAAAAAAAAAAAAAAAAAAAAAAACWAK8AAAA' +
    'CAACAAAAAAAAAAEAAAMg/zgAAAKKAAAAAAJYAAEAAAAAAAAAAAAAAAAAAgAAAooAAAKKAAAAAAAAAA8AAAABAAAAAgADAAEAAAAA' +
    'AAIAAAAAAAAAAAAAAAAAAAAAAAAABAA2AAMAAQQJAAEAGAAAAAMAAQQJAAIADgAYAAMAAQQJAAQAKAAmAAMAAQQJAAYAJgBOAEYA' +
    'aQB4AHQAdQByAGUAIABGAGEAYwBlAFIAZQBnAHUAbABhAHIARgBpAHgAdAB1AHIAZQAgAEYAYQBjAGUAIABSAGUAZwB1AGwAYQBy' +
    'AEYAaQB4AHQAdQByAGUARgBhAGMAZQAtAFIAZQBnAHUAbABhAHIAAAADAAAAAAAA/7UAMgAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'base64',
);
function hashes(pkg: string) {
    return Object.fromEntries(fs.readdirSync(pkg, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => {
            const file = path.join(entry.parentPath, entry.name);
            return [path.relative(pkg, file), sha(fs.readFileSync(file))];
        }));
}
const req = (server: Scratch, route: string, body?: unknown) => fetch(server.base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-canvas': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
});
async function json(server: Scratch, route: string, body?: unknown) {
    const response = await req(server, route, body);
    const value = await response.json() as any;
    assert.ok(response.ok, `${route.split('?')[0]}: ${response.status} ${JSON.stringify(value)}`);
    return value;
}
const browser = chromePath();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-file-transfer-')));
const realTunnel = process.env.CANVAS_REAL_TUNNEL;
const env = {
    CANVAS_HEADLESS: '1', CANVAS_MCP_BACKGROUND: '1',
    CANVAS_TUNNEL_BIN: realTunnel ?? path.join(ROOT, 'test/fixtures/fake-tunnel.sh'),
    CANVAS_FAKE_TUNNEL_DIR: path.join(tmp, 'tunnels'), CANVAS_FAKE_TUNNEL_NODE: process.execPath,
    CANVAS_FAKE_TUNNEL_ANY_PORT: '1', ...(!realTunnel && { CANVAS_CLOUD_HOST_PORT: '0' }),
};
const servers: Scratch[] = [];
const client = new Client({ name: 'file-transfer-qa', version: '1' });
try {
    fs.mkdirSync(env.CANVAS_FAKE_TUNNEL_DIR);
    for (const [folder, label] of [['host', 'Anna'], ['member', 'Ben']]) {
        const home = path.join(tmp, folder);
        fs.mkdirSync(home);
        servers.push(await startServer(home, {
            ...env, HOME: home, CANVAS_STATE_DIR: path.join(home, 'state'),
            CANVAS_CLOUD_SECRETS_FILE: path.join(home, 'secrets.json'), CANVAS_COMMENT_NAME: label,
        }));
    }
    const [hostServer, member] = servers;
    const host = await json(hostServer, '/api/cloud/host/start', { name: 'Transfer Studio', label: 'Anna' });
    assert.match(host.url, /^canvas-cloud:\/\//);
    const invite = await json(hostServer, '/api/cloud/host/invite', { hostId: host.hostId, label: 'Ben', role: 'editor' });
    const joined = await json(member, '/api/cloud/join', { link: invite.link, device: 'Test Mac' });
    const cloud = joined.url;
    assert.equal(cloud, host.url);
    const cloudQuery = '?cloud=' + encodeURIComponent(cloud);
    const status = await json(member, '/api/cloud/status?fresh=1&url=' + encodeURIComponent(cloud));
    assert.deepEqual([status.status, status.role, status.hostedHere], ['connected', 'editor', false]);
    const list = async () => (await json(hostServer, '/api/cloud/files' + cloudQuery)).files;
    assert.deepEqual(await list(), []);

    const source = path.join(tmp, 'member', 'Transfer.canvas');
    const write = (rel: string, bytes: Buffer | string) => {
        const file = path.join(source, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
    };
    const rels = Array.from({ length: 408 }, (_, i) => `media/sub/deep/pixel-${String(i).padStart(3, '0')}.png`);
    rels.push('media/paywall/x.png', 'media/a/b/c.png');
    for (const [index, rel] of rels.entries()) write(rel, png(index));
    const fontRel = 'fonts/embedded/fixture.ttf';
    write(fontRel, font);
    write('shaders/nested/simple.wgsl', 'fn shade() {}');
    const boards = ['Preview', 'Details', 'Archive'];
    write('document.json', JSON.stringify({ version: '2.21', fonts: [{ name: 'Fixture Face', url: fontRel }],
        children: boards.map((id, index) => ({ type: 'frame', id, name: id, width: 96, height: 64, fill: '#ffffff', children: [
            { type: 'rectangle', id: 'Image' + index, width: 32, height: 32, fill: { type: 'image', url: rels.at(-1 - index) } },
            { type: 'text', id: 'Title' + index, content: 'A', fontFamily: 'Fixture Face', fontSize: 24, fill: '#123456' },
        ] })) }));
    write('widgets.json', JSON.stringify({ widgets: [], pages: boards.map((name, i) => ({ id: 'page-' + i, name, boards: [name] })) }));
    const comments = emptyComments();
    for (let i = 0; i < 135; i++) {
        const anchor = { nodeId: 'Title' + (i % boards.length), x: 0.5, y: 0.5 };
        applyOp(comments.threads, comments.doc, { kind: 'thread.create', anchor, thread: randomUUID(),
            comment: randomUUID(), body: 'Review note ' + i }, { name: 'Ben' }, '2026-01-01T00:00:00.000Z');
    }
    write('comments.json', JSON.stringify(comments));
    const original = hashes(source);
    assert.equal(new Set(rels.map(rel => original[rel])).size, 410);
    const upload = '/api/cloud/files/move?file=' + encodeURIComponent(path.join(source, 'document.json'));
    const cloudDisk = path.join(tmp, 'host', 'state', 'cloud-host');
    const db = new DatabaseSync(path.join(cloudDisk, 'team.sqlite'), { readOnly: true });
    const usage = () => Number(db.prepare("SELECT COALESCE(SUM(used),0) AS total FROM file_transfer_usage WHERE kind='requests'").get()!.total);
    try {
        const injection = 'media/zz/failure.png';
        write(injection, 'Not an image');
        const failedUpload = await req(member, upload, { cloud });
        assert.equal(failedUpload.status, 400);
        assert.match((await failedUpload.json() as { error: string }).error, /not image\/png/);
        assert.equal(usage(), 2, 'failed during the second upload batch');
        assert.deepEqual(await list(), []);
        assert.equal(db.prepare('SELECT count(*) AS n FROM files').get()!.n, 0, 'failed import removed its room');
        assert.equal(db.prepare('SELECT count(*) AS n FROM storage_held').get()!.n, 0, 'failed import released storage');
        fs.unlinkSync(path.join(source, injection));
        fs.rmdirSync(path.dirname(path.join(source, injection)));
        assert.deepEqual(hashes(source), original);
        console.log('PASS second upload batch failure kept every local byte and removed the hidden import');

        const before = usage();
        const moved = await json(member, upload, { cloud });
        const uploadRequests = usage() - before;
        assert.equal(moved.verified, true);
        assert.ok(uploadRequests <= 8, `too many batch requests: ${uploadRequests}`);
        assert.equal(fs.existsSync(source), false);
        assert.deepEqual((await list()).map((row: { id: string }) => row.id), [moved.id]);
        const opened = await json(hostServer, '/api/cloud/files/open', { cloud, id: moved.id });
        const checkAsset = async (server: Scratch, rel: string) => {
            const res = await fetch(server.base + '/asset?p=' + encodeURIComponent(path.join(opened.file, rel)));
            assert.equal(res.status, 200);
            assert.equal(sha(Buffer.from(await res.arrayBuffer())), original[rel]);
        };
        for (const rel of [rels.at(-1)!, rels.at(-2)!, fontRel]) await checkAsset(hostServer, rel);
        const fontResponse = await fetch(hostServer.base + '/api/fonts/file?family=Fixture%20Face&file=' + encodeURIComponent(opened.file));
        assert.equal(fontResponse.status, 200);
        assert.equal(fontResponse.headers.get('x-font-source'), 'document');

        const corrupt = path.join(cloudDisk, 'objects', 'files', moved.id, 'blobs', original['media/sub/deep/pixel-407.png']);
        const correct = fs.readFileSync(corrupt), broken = Buffer.from(correct);
        broken[broken.length - 1] ^= 1;
        fs.writeFileSync(corrupt, broken);
        const download = { cloud, id: moved.id, target: source, move: true };
        const beforeFailure = usage();
        try {
            const failedDownload = await req(member, '/api/cloud/files/download', download);
            assert.equal(failedDownload.status, 400);
            assert.match((await failedDownload.json() as { error: string }).error, /Blob hash mismatch/);
            assert.equal(usage() - beforeFailure, 2, 'failed during the second download batch');
            assert.equal(fs.existsSync(source), false);
            assert.deepEqual((await list()).map((row: { id: string }) => row.id), [moved.id]);
        } finally { fs.writeFileSync(corrupt, correct); }
        console.log('PASS second download batch failure kept the Cloud file and exposed no local package');
        const returned = await json(member, '/api/cloud/files/download', download);
        assert.equal(returned.file, source);
        assert.equal(returned.moved, true);
        assert.deepEqual(await list(), []);

        const after = hashes(source);
        assert.notEqual(after['comments.json'], original['comments.json']);
        const returnedComments = JSON.parse(fs.readFileSync(path.join(source, 'comments.json'), 'utf8')) as typeof comments;
        assert.notEqual(returnedComments.doc, comments.doc);
        assert.equal(returnedComments.seq, 0);
        assert.deepEqual(returnedComments.outbox, []);
        const contentOf = (state: typeof comments) => Object.fromEntries(state.threads.map(thread => [
            thread.id, { anchor: thread.anchor, comments: thread.comments.map(comment => [comment.id, comment.body, comment.author.name]) },
        ]));
        assert.deepEqual(contentOf(returnedComments), contentOf(comments));
        delete after['comments.json'];
        delete original['comments.json'];
        assert.deepEqual(after, original);
        console.log(`PASS ${rels.length} distinct images, embedded font, shader, document and pages retained their hashes (${uploadRequests} transfer requests to import and verify)`);
    } finally { db.close(); }

    const health = await json(member, '/health');
    await client.connect(new StdioClientTransport({
        command: process.execPath, args: [path.join(ROOT, 'mcp/server.ts')], stderr: 'pipe',
        env: { CANVAS_CHROME: browser, CANVAS_MCP_BACKGROUND: '1', CANVAS_MCP_NO_SPAWN: '1',
            CANVAS_MCP_WANT_VERSION: health.version, CANVAS_PORT: String(member.port) },
    }));
    const result = await client.callTool({ name: 'render_node', arguments: { file: source, id: 'Preview' } });
    assert.ok(!result.isError, JSON.stringify(result.content));
    assert.ok(Array.isArray(result.content) && result.content.some(c => c.type === 'image' &&
        typeof c.data === 'string' && Buffer.from(c.data, 'base64').subarray(1, 4).toString() === 'PNG'));
    console.log(`PASS reopened and rendered the returned package headlessly through the ${realTunnel ? 'bundled' : 'loopback test'} tunnel`);
} finally {
    await client.close();
    await Promise.all(servers.map(server => server.stop()));
    fs.rmSync(tmp, { recursive: true, force: true });
}
