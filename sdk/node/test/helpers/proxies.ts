// Real local servers for proxy tests: an HTTP origin, an HTTP proxy (absolute-form + CONNECT) and a
// SOCKS5 proxy (optional RFC 1929 auth). Each records what it saw, so a test can prove a request
// actually went THROUGH the proxy instead of trusting the client's word for it.
import http from "node:http";
import net from "node:net";

export interface Started<T> {
  port: number;
  log: T[];
  close(): Promise<void>;
}

function closeServer(s: net.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const c of sockets) c.destroy();
  return new Promise((r) => s.close(() => r()));
}

function track(s: net.Server): Set<net.Socket> {
  const sockets = new Set<net.Socket>();
  s.on("connection", (c: net.Socket) => { sockets.add(c); c.on("close", () => sockets.delete(c)); });
  return sockets;
}

export async function startOrigin(
  handler: (req: http.IncomingMessage, body: string) => { status?: number; body: string; headers?: Record<string, string> },
): Promise<Started<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>> {
  const log: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const r = handler(req, body);
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(r.body);
    });
  });
  const sockets = track(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as net.AddressInfo).port, log, close: () => closeServer(server, sockets) };
}

export async function startHttpProxy(opts: { requireAuth?: string } = {}): Promise<Started<{ kind: "absolute" | "connect"; target: string; auth?: string }>> {
  const log: Array<{ kind: "absolute" | "connect"; target: string; auth?: string }> = [];
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const head = buf.subarray(0, end).toString("latin1").split("\r\n");
      const rest = buf.subarray(end + 4);
      const [method, target] = head[0].split(" ");
      const authLine = head.find((l) => l.toLowerCase().startsWith("proxy-authorization:"));
      const auth = authLine ? authLine.slice(authLine.indexOf(":") + 1).trim() : undefined;
      log.push({ kind: method === "CONNECT" ? "connect" : "absolute", target, auth });
      if (opts.requireAuth && auth !== opts.requireAuth) {
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (method === "CONNECT") {
        const [h, p] = target.split(":");
        const up = net.connect(Number(p), h, () => {
          client.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (rest.length) up.write(rest);
          client.pipe(up).pipe(client);
        });
        up.on("error", () => client.destroy());
      } else {
        const u = new URL(target);
        const up = net.connect(Number(u.port || 80), u.hostname, () => {
          const fwd = [`${method} ${u.pathname}${u.search} HTTP/1.1`, ...head.slice(1).filter((l) => !/^proxy-/i.test(l))];
          up.write(fwd.join("\r\n") + "\r\n\r\n");
          if (rest.length) up.write(rest);
          client.pipe(up).pipe(client);
        });
        up.on("error", () => client.destroy());
      }
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
  const sockets = track(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as net.AddressInfo).port, log, close: () => closeServer(server, sockets) };
}

export async function startSocks5(opts: { user?: string; pass?: string } = {}): Promise<Started<{ host: string; port: number; user?: string }>> {
  const log: Array<{ host: string; port: number; user?: string }> = [];
  const server = net.createServer((client) => {
    client.on("error", () => {});
    const read = (n: number) =>
      new Promise<Buffer>((resolve) => {
        const tryRead = () => {
          const b = client.read(n) as Buffer | null;
          if (b) resolve(b);
          else client.once("readable", tryRead);
        };
        tryRead();
      });
    (async () => {
      const [ver, nMethods] = await read(2);
      if (ver !== 5) return client.destroy();
      const methods = [...(await read(nMethods))];
      let user: string | undefined;
      if (opts.user !== undefined) {
        if (!methods.includes(2)) { client.end(Buffer.from([5, 0xff])); return; }
        client.write(Buffer.from([5, 2]));
        const [, ulen] = await read(2);
        user = (await read(ulen)).toString();
        const [plen] = await read(1);
        const pass = (await read(plen)).toString();
        const ok = user === opts.user && pass === opts.pass;
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) { client.end(); return; }
      } else {
        client.write(Buffer.from([5, 0]));
      }
      const [, , , atyp] = await read(4);
      let host = "";
      if (atyp === 1) host = [...(await read(4))].join(".");
      else if (atyp === 3) host = (await read((await read(1))[0])).toString();
      else return client.destroy();
      const port = (await read(2)).readUInt16BE(0);
      log.push({ host, port, user });
      const up = net.connect(port, host, () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        client.pipe(up).pipe(client);
      });
      up.on("error", () => { client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); });
    })().catch(() => client.destroy());
  });
  const sockets = track(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as net.AddressInfo).port, log, close: () => closeServer(server, sockets) };
}
