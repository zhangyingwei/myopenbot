import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

const MAGIC_COOKIE = 0x2112_a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;

export interface LocalStunServer {
  close(): Promise<void>;
}

export function startLocalStunServer(options: { host?: string; port: number }): Promise<LocalStunServer> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createSocket({ type: "udp4", reuseAddr: true });
    const onMessage = (message: Buffer, remote: RemoteInfo): void => {
      const reply = bindingSuccess(message, remote);
      if (reply === null) return;
      socket.send(reply, remote.port, remote.address, () => undefined);
    };
    const onBindError = (error: Error): void => {
      socket.close();
      reject(error);
    };
    socket.once("error", onBindError);
    socket.on("message", onMessage);
    socket.bind(options.port, options.host ?? "0.0.0.0", () => {
      socket.off("error", onBindError);
      socket.on("error", () => undefined);
      resolve({
        close: () =>
          new Promise((done) => {
            socket.removeListener("message", onMessage);
            try {
              socket.close(() => done());
            } catch {
              done();
            }
          }),
      });
    });
  });
}

function bindingSuccess(request: Buffer, remote: RemoteInfo): Buffer | null {
  if (request.length < 20) return null;
  if (request.readUInt16BE(0) !== BINDING_REQUEST) return null;
  if (request.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  const length = request.readUInt16BE(2);
  if (20 + length > request.length) return null;
  const octets = parseIPv4(remote.address);
  if (octets === null) return null;
  const transaction = request.subarray(8, 20);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(12, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transaction.copy(header, 8);
  const value = Buffer.alloc(8);
  value.writeUInt8(0, 0);
  value.writeUInt8(0x01, 1);
  value.writeUInt16BE(remote.port ^ (MAGIC_COOKIE >>> 16), 2);
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(MAGIC_COOKIE, 0);
  for (let index = 0; index < 4; index += 1) {
    value.writeUInt8((octets[index] ?? 0) ^ (cookie[index] ?? 0), 4 + index);
  }
  const attribute = Buffer.alloc(12);
  attribute.writeUInt16BE(XOR_MAPPED_ADDRESS, 0);
  attribute.writeUInt16BE(8, 2);
  value.copy(attribute, 4);
  return Buffer.concat([header, attribute]);
}

function parseIPv4(address: string): number[] | null {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4) return null;
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}
