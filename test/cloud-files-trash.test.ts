import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trashPackage } from '../src/cloud-files-trash.ts';

for (const failure of ['none', 'copy', 'remove'] as const) test(`cross-volume Trash move: ${failure}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-trash-'));
    const source = path.join(dir, 'Design.canvas'), trash = path.join(dir, 'trash');
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'document.json'), '{"children":[]}');
    let removed = false;
    const io = {
        ...fs,
        renameSync(from: fs.PathLike, to: fs.PathLike) {
            if (String(from) === source) throw Object.assign(new Error('cross volume'), { code: 'EXDEV' });
            return fs.renameSync(from, to);
        },
        cpSync(from: string | URL, to: string | URL, opts?: fs.CopySyncOptions) {
            fs.cpSync(from, to, opts);
            if (failure === 'copy' && from === source) throw new Error('copy failed');
        },
        rmSync(p: fs.PathLike, opts?: fs.RmOptions) {
            if (failure === 'remove' && String(p) === source && !removed) {
                removed = true; fs.unlinkSync(path.join(source, 'document.json')); throw new Error('remove failed');
            }
            fs.rmSync(p, opts);
        },
    };
    try {
        if (failure === 'none') {
            const dest = trashPackage(source, trash, io);
            assert.equal(fs.existsSync(source), false);
            assert.equal(fs.readFileSync(path.join(dest, 'document.json'), 'utf8'), '{"children":[]}');
        } else {
            assert.throws(() => trashPackage(source, trash, io), /failed/);
            assert.equal(fs.readFileSync(path.join(source, 'document.json'), 'utf8'), '{"children":[]}');
            assert.deepEqual(fs.readdirSync(trash), []);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
