import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('test processes skip default server logs but can opt into scratch logs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-test-log-'));
    const saved = { HOME: process.env.HOME, CANVAS_LOG_DIR: process.env.CANVAS_LOG_DIR };
    process.env.HOME = dir;
    delete process.env.CANVAS_LOG_DIR;
    try {
        await import('../src/server.ts');
        const { writerHooks } = await import('../src/docwriter.ts');
        writerHooks.problem?.('placeholder.canvas', 'Synthetic save failure');
        assert.equal(fs.existsSync(path.join(dir, 'Library/Logs/Canvas/server.log')), false);
        process.env.CANVAS_LOG_DIR = path.join(dir, 'logs');
        writerHooks.problem?.('placeholder.canvas', 'Synthetic save failure');
        assert.match(fs.readFileSync(path.join(dir, 'logs/server.log'), 'utf8'), /Synthetic save failure/);
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
