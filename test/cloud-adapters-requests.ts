type Call = (path: string, method?: string, body?: unknown) => Promise<Response>;

export async function contract(call: Call, assert: { equal(actual: unknown, expected: unknown, message?: string): void; deepEqual(actual: unknown, expected: unknown): void }) {
  const doc = crypto.randomUUID();
  const op = { doc, opId: crypto.randomUUID(), at: new Date().toISOString(), op: {
    kind: "thread.create", thread: crypto.randomUUID(), comment: crypto.randomUUID(), body: "Hello", anchor: { x: 1, y: 2 },
  } };
  const requests: [string, string, unknown, number, (body: any) => void][] = [
    ["/v1/docs/not-a-uuid/threads", "GET", undefined, 400, b => assert.equal(b.code, "invalid")],
    [`/v1/docs/${doc}/threads`, "GET", undefined, 404, b => assert.equal(b.code, "not_found")],
    ["/v1/docs", "POST", { doc }, 200, b => assert.equal(b.doc, doc)],
    [`/v1/docs/${doc}/threads`, "GET", undefined, 200, b => assert.deepEqual(b, { threads: [], seq: 0 })],
    [`/v1/docs/${doc}/threads?since=-1`, "GET", undefined, 400, b => assert.equal(b.code, "invalid")],
    [`/v1/docs/${doc}/ops`, "POST", { ops: "invalid" }, 400, b => assert.equal(b.code, "invalid")],
    [`/v1/docs/${doc}/ops`, "POST", { ops: [op] }, 200, b => assert.deepEqual(b.acks, [{ opId: op.opId, seq: 1 }])],
    [`/v1/docs/${doc}/ops`, "POST", { ops: [op] }, 200, b => assert.deepEqual(b.acks, [{ opId: op.opId, seq: 1 }])],
    [`/v1/docs/${doc}/threads`, "GET", undefined, 200, b => { assert.equal(b.seq, 1); assert.equal(b.threads.length, 1); assert.equal(b.threads[0].id, op.op.thread); }],
    [`/v1/docs/${doc}/threads?since=1`, "GET", undefined, 200, b => assert.deepEqual(b, { seq: 1, entries: [] })],
    [`/v1/docs/${doc}/threads`, "POST", {}, 404, b => assert.equal(b.code, "not_found")],
  ];
  for (const [url, method, body, status, check] of requests) {
    const response = await call(url, method, body);
    assert.equal(response.status, status, `${method} ${url}`);
    check(await response.json());
  }
}
