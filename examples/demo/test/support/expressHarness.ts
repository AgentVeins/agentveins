import { EventEmitter } from "node:events";
import type { Express, Request, Response as ExpressResponse } from "express";

// The suite runs with fetch/http.request/https.request/net.connect/tls.connect/dns.lookup all
// blocked (including a plain `app.listen(0, "127.0.0.1")`, since Node resolves even a literal IP
// through dns.lookup before binding). Driving the Express app in-process — building the minimal
// req/res shape Express needs and calling the app as a plain function — exercises the exact same
// routing and handler code a real request would, without touching any network primitive.
interface FakeRequest extends EventEmitter {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string>;
}

interface FakeExpressResponse extends EventEmitter {
  statusCode: number;
  headersSent: boolean;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
  removeHeader(name: string): void;
  hasHeader(name: string): boolean;
  write(chunk?: unknown): boolean;
  end(chunk?: unknown, encoding?: unknown): void;
}

export interface DrivenResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

export function driveRequest(
  app: Express,
  path: string,
  requestHeaders: Record<string, string> = {},
): Promise<DrivenResponse> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as FakeRequest;
    req.method = "GET";
    req.url = path;
    req.httpVersion = "1.1";
    req.headers = Object.fromEntries(
      Object.entries(requestHeaders).map(([name, value]) => [name.toLowerCase(), value]),
    );

    const outHeaders: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = new EventEmitter() as FakeExpressResponse;
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = (name, value) => {
      outHeaders[name.toLowerCase()] = String(value);
    };
    res.getHeader = (name) => outHeaders[name.toLowerCase()];
    res.removeHeader = (name) => {
      delete outHeaders[name.toLowerCase()];
    };
    res.hasHeader = (name) => name.toLowerCase() in outHeaders;
    res.write = (chunk) => {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return true;
    };
    res.end = (chunk) => {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      res.headersSent = true;
      res.emit("finish");
    };
    res.on("finish", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
        resolve({ status: res.statusCode, body, headers: new Headers(outHeaders) });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    app(req as unknown as Request, res as unknown as ExpressResponse, (err?: unknown) => {
      if (err !== undefined) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

export function fetchImplFor(app: Express, path: string): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const requestHeaders: Record<string, string> = {};
    if (init?.headers !== undefined) {
      new Headers(init.headers).forEach((value, key) => {
        requestHeaders[key] = value;
      });
    }
    const driven = await driveRequest(app, path, requestHeaders);
    return new Response(JSON.stringify(driven.body), {
      status: driven.status,
      headers: driven.headers,
    });
  }) as typeof fetch;
}
