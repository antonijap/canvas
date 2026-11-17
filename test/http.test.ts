// safeFetch: bounded time and size, JSON only, redirects that drop credentials, addresses it refuses.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { fakeServer, sendJson, type Fake } from "./helpers.ts";
import { blockedReason, checkStaticHeaders, isLocalHost, safeFetch, safeFetchJson } from "../src/widgets/http.ts";

const open: Fake[] = [];
const serve = async (h: Parameters<typeof fakeServer>[0]) => {
  const f = await fakeServer(h);
  open.push(f);
  return f;
};
after(async () => {
  await Promise.all(open.map((f) => f.close()));
});

const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: any) => e.code === code, code);

describe("safeFetch", () => {
  test("a JSON answer comes back parsed", async () => {
    const f = await serve((_q, res) => sendJson(res, { a: 1 }));
    const r = await safeFetchJson({ url: f.url, maxBytes: 1000 });
    assert.deepEqual(r.json, { a: 1 });
  });

  test("total time is bounded", async () => {
    const f = await serve(() => {});
    const t = Date.now();
    await rejects(safeFetch({ url: f.url, maxBytes: 1000, totalMs: 300 }), "timeout");
    assert.ok(Date.now() - t < 2000);
  });

  test("a server that goes quiet mid-answer is cut off by the idle timeout", async () => {
    const f = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[1,");
    });
    await rejects(safeFetch({ url: f.url, maxBytes: 1000, idleMs: 200, totalMs: 5000 }), "timeout");
  });

  test("size cap: by content-length and by streaming", async () => {
    const big = await serve((_q, res) => sendJson(res, { pad: "x".repeat(5000) }));
    await rejects(safeFetch({ url: big.url, maxBytes: 1000 }), "too-large");
    const stream = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.write("x".repeat(600));
      setTimeout(() => res.end("x".repeat(600)), 20);
    });
    await rejects(safeFetch({ url: stream.url, maxBytes: 1000 }), "too-large");
  });

  test("a 2xx must be JSON", async () => {
    const html = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>hi</p>");
    });
    await rejects(safeFetchJson({ url: html.url, maxBytes: 1000 }), "bad-content-type");
    const broken = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end("{oops");
    });
    await rejects(safeFetchJson({ url: broken.url, maxBytes: 1000 }), "bad-json");
    const ld = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "application/vnd.api+json" });
      res.end("[1]");
    });
    assert.deepEqual((await safeFetchJson({ url: ld.url, maxBytes: 1000 })).json, [1]);
    const err = await serve((_q, res) => sendJson(res, { e: 1 }, 500));
    assert.equal((await safeFetchJson({ url: err.url, maxBytes: 1000 })).status, 500);
  });

  test("redirects: followed up to 3, and credentials never cross to another origin", async () => {
    const other = await serve((_q, res) => sendJson(res, { at: "other" }));
    const home = await serve((q, res) => {
      if (q.url === "/same") return sendJson(res, { at: "home" });
      if (q.url === "/hop") {
        res.writeHead(302, { location: "/same" });
        return res.end();
      }
      if (q.url === "/away") {
        res.writeHead(302, { location: `${other.url}/landing` });
        return res.end();
      }
      res.writeHead(302, { location: "/loop" });
      res.end();
    });
    const secret = { name: "authorization", value: "Bearer s3cr3t-token" };
    const same = await safeFetchJson({ url: `${home.url}/hop`, maxBytes: 1000, secret, headers: { "x-extra": "1" } });
    assert.deepEqual(same.json, { at: "home" });
    assert.equal(home.hits.at(-1)!.headers.authorization, "Bearer s3cr3t-token");
    const away = await safeFetchJson({ url: `${home.url}/away`, maxBytes: 1000, secret, headers: { "x-extra": "1" } });
    assert.deepEqual(away.json, { at: "other" });
    assert.equal(other.hits.at(-1)!.headers.authorization, undefined, "secret followed a cross-origin redirect");
    assert.equal(other.hits.at(-1)!.headers["x-extra"], undefined, "static headers followed a cross-origin redirect");
    await rejects(safeFetch({ url: `${home.url}/loop`, maxBytes: 1000 }), "redirect-limit");
  });

  test("addresses it refuses: link-local, unspecified, multicast, mapped forms", async () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "0.0.0.0", "224.0.0.1", "[fe80::1]", "[::]", "[ff02::1]", "[::ffff:169.254.169.254]", "[::ffff:a9fe:a9fe]"]) {
      await rejects(safeFetch({ url: `http://${ip}:9/`, maxBytes: 10, totalMs: 500 }), "blocked-address");
    }
    assert.equal(blockedReason("127.0.0.1"), null);
    assert.equal(blockedReason("10.1.2.3"), null);
    assert.equal(blockedReason("192.168.1.9"), null);
    assert.equal(blockedReason("::1"), null);
    assert.equal(blockedReason("93.184.216.34"), null);
  });

  test("a redirect into a refused address is refused too", async () => {
    const f = await serve((_q, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await rejects(safeFetch({ url: f.url, maxBytes: 100 }), "blocked-address");
  });

  test("user info, odd schemes and junk are rejected", async () => {
    await rejects(safeFetch({ url: "http://user:pw@127.0.0.1:9/", maxBytes: 10 }), "bad-url");
    await rejects(safeFetch({ url: "http://user@127.0.0.1:9/", maxBytes: 10 }), "bad-url");
    await rejects(safeFetch({ url: "file:///etc/passwd", maxBytes: 10 }), "bad-url");
    await rejects(safeFetch({ url: "ftp://example.com/", maxBytes: 10 }), "bad-url");
    await rejects(safeFetch({ url: "not a url", maxBytes: 10 }), "bad-url");
  });

  test("a secret goes over plain http only to this Mac and the local network", async () => {
    await rejects(safeFetch({ url: "http://example.com/", maxBytes: 10, secret: { name: "authorization", value: "x" } }), "insecure-auth");
    await rejects(safeFetch({ url: "http://93.184.216.34/", maxBytes: 10, secret: { name: "authorization", value: "x" } }), "insecure-auth");
    const f = await serve((_q, res) => sendJson(res, { ok: true }));
    await safeFetchJson({ url: f.url, maxBytes: 100, secret: { name: "x-api-key", value: "abc" } });
    assert.equal(f.hits[0].headers["x-api-key"], "abc");
    for (const h of ["localhost", "127.0.0.1", "[::1]", "10.0.0.5", "172.20.1.1", "192.168.0.2", "mac.local"]) assert.equal(isLocalHost(h), true, h);
    for (const h of ["example.com", "172.32.0.1", "8.8.8.8", "evil.local.example.com"]) assert.equal(isLocalHost(h), false, h);
  });

  test("no cookies and no connection reuse: each call stands alone", async () => {
    const f = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=1" });
      res.end("{}");
    });
    await safeFetchJson({ url: f.url, maxBytes: 100 });
    await safeFetchJson({ url: f.url, maxBytes: 100 });
    assert.equal(f.hits[1].headers.cookie, undefined);
  });

  test("concurrency: 2 per host, 4 overall", async () => {
    let now = 0;
    let peak = 0;
    const slow: Parameters<typeof fakeServer>[0] = (_q, res) => {
      now++;
      peak = Math.max(peak, now);
      setTimeout(() => {
        now--;
        sendJson(res, {});
      }, 120);
    };
    const one = await serve(slow);
    await Promise.all(Array.from({ length: 6 }, () => safeFetchJson({ url: one.url, maxBytes: 100 })));
    assert.equal(peak, 2, "per-host limit");
    peak = 0;
    const many = await Promise.all(Array.from({ length: 8 }, () => serve(slow)));
    await Promise.all(many.flatMap((f) => [safeFetchJson({ url: f.url, maxBytes: 100 }), safeFetchJson({ url: f.url, maxBytes: 100 })]));
    assert.equal(peak, 4, "global limit");
  });

  test("static headers may not carry credentials or break the request", () => {
    checkStaticHeaders({ "x-team": "ops", accept: "application/json" });
    for (const k of ["Authorization", "cookie", "Host", "proxy-authorization", "Content-Length", "bad name", "x\r\ny"]) assert.throws(() => checkStaticHeaders({ [k]: "v" }), /not allowed/, k);
    assert.throws(() => checkStaticHeaders({ "x-a": "line\nbreak" }), /not allowed/);
  });
});
