import { test } from "node:test";
import assert from "node:assert/strict";
import { reconnectingStream } from "../src/event-stream.ts";

test("failed event streams back off, refresh their URL, and stop while hidden", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.EventSource;
  const streams: FakeSource[] = [];
  class FakeSource extends EventTarget {
    closed = false;
    readonly url: string;
    constructor(url: string) { super(); this.url = url; streams.push(this); }
    close() { this.closed = true; }
  }
  globalThis.EventSource = FakeSource as unknown as typeof EventSource;
  t.after(() => { globalThis.EventSource = original; });
  let revision = 0, documents = 0, disconnects = 0;
  const stream = reconnectingStream(() => "/events?since=" + revision, () => { disconnects++; });
  stream.addEventListener("doc", () => { documents++; revision++; });
  stream.connect();
  streams[0].dispatchEvent(new Event("error"));
  assert.equal(streams[0].closed, true);
  t.mock.timers.tick(249);
  assert.equal(streams.length, 1);
  t.mock.timers.tick(1);
  streams[1].dispatchEvent(new Event("error"));
  t.mock.timers.tick(499);
  assert.equal(streams.length, 2);
  t.mock.timers.tick(1);
  streams[2].dispatchEvent(new Event("open"));
  streams[2].dispatchEvent(new Event("doc"));
  assert.equal(documents, 1);
  streams[2].dispatchEvent(new Event("error"));
  t.mock.timers.tick(250);
  assert.equal(streams[3].url, "/events?since=1");
  streams[3].dispatchEvent(new Event("error"));
  stream.close();
  t.mock.timers.tick(4000);
  assert.equal(streams.length, 4);
  assert.equal(disconnects, 5);
  stream.connect();
  streams[4].dispatchEvent(new Event("doc"));
  assert.equal(documents, 2);
});
