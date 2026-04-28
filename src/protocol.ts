import * as net from "node:net";
import { DaemonRequest, DaemonResponse } from "./types";

export function readMessage(socket: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let needLen = -1;

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (needLen < 0) {
          if (buf.length < 4) return;
          needLen = buf.readUInt32BE(0);
          buf = buf.subarray(4);
        }
        if (buf.length < needLen) return;
        const payload = buf.subarray(0, needLen).toString("utf8");
        socket.off("data", onData);
        socket.off("error", onErr);
        socket.off("end", onEnd);
        try {
          resolve(JSON.parse(payload));
        } catch (e) {
          reject(e as Error);
        }
        return;
      }
    };
    const onErr = (e: Error) => reject(e);
    const onEnd = () => reject(new Error("connection ended before message"));

    socket.on("data", onData);
    socket.once("error", onErr);
    socket.once("end", onEnd);
  });
}

export function writeMessage(socket: net.Socket, msg: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const json = Buffer.from(JSON.stringify(msg), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(json.length, 0);
    socket.write(Buffer.concat([header, json]), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export type { DaemonRequest, DaemonResponse };
