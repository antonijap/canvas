import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readMoveAsset } from '../src/cloud-files-assets.ts';

test('import reads nested package assets while refusing escapes and links', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-move-assets-'));
    const pkg = path.join(dir, 'Input.canvas');
    fs.mkdirSync(path.join(pkg, 'assets/pictures'), { recursive: true });
    const inside = path.join(pkg, 'assets/pictures/image.png');
    const outside = path.join(dir, 'outside.png');
    fs.writeFileSync(inside, 'placeholder image');
    fs.writeFileSync(outside, 'outside content');
    try {
        assert.equal(readMoveAsset(pkg, 'assets/pictures/image.png').toString(), 'placeholder image');
        for (const ref of ['../outside.png', outside, 'assets/../../outside.png', 'assets\\image.png', 'file:outside.png', 'https://example.test/image.png', './assets/pictures/image.png'])
            assert.throws(() => readMoveAsset(pkg, ref), /outside the package/);
        fs.symlinkSync(outside, path.join(pkg, 'assets/soft.png'));
        assert.throws(() => readMoveAsset(pkg, 'assets/soft.png'), /linked/);
        fs.symlinkSync(path.dirname(outside), path.join(pkg, 'linked'));
        assert.throws(() => readMoveAsset(pkg, 'linked/outside.png'), /linked/);
        fs.linkSync(outside, path.join(pkg, 'assets/hard.png'));
        assert.throws(() => readMoveAsset(pkg, 'assets/hard.png'), /linked/);
        assert.throws(() => readMoveAsset(pkg, 'assets/pictures'), /linked or changed/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
