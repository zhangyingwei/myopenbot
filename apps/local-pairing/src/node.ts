import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

const MAX_BODY_BYTES = 1_000_000;

export type LocalPairingWebHandler = (request: Request) => Promise<Response>;
export type LocalPairingErrorReporter = (message: string, error: unknown) => void;

export interface LocalPairingServerOptions {
  host: string;
  port: number;
  onError?: LocalPairingErrorReporter;
}

export function createLocalPairingNodeListener(
  handle: LocalPairingWebHandler,
  onError?: LocalPairingErrorReporter,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handleNodeRequest(handle, request, response, onError);
  };
}

export async function startLocalPairingServer(
  handle: LocalPairingWebHandler,
  options: LocalPairingServerOptions,
): Promise<Server> {
  const server = createServer(createLocalPairingNodeListener(handle, options.onError));
  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onListenError);
      resolve();
    };
    server.once("error", onListenError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  return server;
}

export function closeLocalPairingServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function handleNodeRequest(
  handle: LocalPairingWebHandler,
  request: IncomingMessage,
  response: ServerResponse,
  onError?: LocalPairingErrorReporter,
): Promise<void> {
  try {
    const body = await readBody(request);
    const host = request.headers.host ?? "127.0.0.1";
    const webRequest = new Request(`http://${host}${request.url ?? "/"}`, {
      method: request.method ?? "GET",
      headers: webHeaders(request.headers),
      ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
    });
    const webResponse = await handle(webRequest);
    const bytes = Buffer.from(await webResponse.arrayBuffer());
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(bytes);
  } catch (error) {
    onError?.("Local pairing server request failed", error);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { code: "internal_error", message: "The local pairing service failed." } }));
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("The request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(bytes);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function webHeaders(headers: IncomingHttpHeaders): Headers {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) entries.push([key, item]);
    } else {
      entries.push([key, value]);
    }
  }
  return new Headers(entries);
}
