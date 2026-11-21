// Keep Chromium requests on the approved origin, including redirects and subresources.
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { blockedReason, checkedLookup } from "./http.ts";

export async function withPreviewProxy<T>(url: string, capture: (flags: string[]) => Promise<T>): Promise<T> {
  const origin = new URL(url);
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  const authority = origin.hostname + ":" + (origin.port || "443");
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const proxy = http.createServer((req, res) => {
    let target: URL | undefined;
    try { target = new URL(req.url ?? ""); } catch {}
    if (target?.protocol !== "http:" || target.origin !== origin.origin || target.username || target.password) {
      res.writeHead(403).end();
      return;
    }
    const headers: http.IncomingHttpHeaders = { ...req.headers, host: origin.host };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(target, { method: req.method, headers, lookup: checkedLookup, agent: false }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.on("connection", track);
  proxy.on("connect", (req, client, head) => {
    if (origin.protocol !== "https:" || req.url !== authority || blockedReason(hostname)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: hostname, port: Number(origin.port || 443), lookup: checkedLookup });
    track(upstream);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  try {
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const { port } = proxy.address() as net.AddressInfo;
    return await capture([
      "--proxy-server=http://127.0.0.1:" + port,
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]);
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.close();
  }
}
