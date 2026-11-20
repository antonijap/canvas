import assert from 'node:assert/strict';
import { test } from 'node:test';
import { macUsageTone, MacUsage } from '../cloud/adapters/mac/usage.ts';
import { SqliteStore } from '../cloud/adapters/mac/sqlite.ts';
const GB = 1024 ** 3;
test('Mac usage warns on disk, storage and repeated restarts', () => {
    assert.equal(macUsageTone(40*GB, GB, 0), 'normal');
    assert.equal(macUsageTone(19*GB, GB, 0), 'amber');
    assert.equal(macUsageTone(40*GB, 21*GB, 0), 'amber');
    assert.equal(macUsageTone(4*GB, GB, 0), 'red');
    assert.equal(macUsageTone(40*GB, GB, 4), 'red');
});
test('usage survives restarts and expires old messages and restarts', () => {
    const db = new SqliteStore(':memory:');
    let now = 1000;
    try {
        let meter = new MacUsage(db, () => now);
        meter.message(); now += 1000;
        assert.equal(meter.read().uptimeMs, 1000);
        assert.equal(meter.read().messages24h, 1);
        for (let i=0;i<4;i++) { now+=1000; meter = new MacUsage(db, () => now); }
        assert.equal(meter.read().restartsHour, 4);
        assert.equal(meter.read().messages24h, 1);
        now += 86400000;
        assert.equal(meter.read().restartsHour, 0);
        assert.equal(meter.read().messages24h, 0);
    } finally { db.close(); }
});
