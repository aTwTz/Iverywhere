import net from 'node:net';
import {
  createReader,
  createWriter,
  decodeMessage,
  decodeQid,
  encodeMessage,
  MESSAGE,
} from '../server/protocol.js';

export class P9Client {
  constructor() {
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.nextTag = 1;
    this.pending = new Map();
  }

  connect({ host = '127.0.0.1', port, path }) {
    return new Promise((resolve, reject) => {
      const options = path ? { path } : { host, port };
      this.socket = net.createConnection(options, resolve);
      this.socket.on('data', (chunk) => this.#handleData(chunk));
      this.socket.on('error', reject);
    });
  }

  disconnect() {
    this.socket?.destroy();
    this.socket = undefined;
  }

  version(msize = 65536) {
    return this.request(MESSAGE.Tversion, createWriter().u32(msize).string('9P2000').build(), MESSAGE.Rversion);
  }

  attach({ fid = 1, afid = 0xffffffff, uname = 'local', aname = '' }) {
    const payload = createWriter()
      .u32(fid)
      .u32(afid)
      .string(uname)
      .string(aname)
      .u32(0)
      .build();
    return this.request(MESSAGE.Tattach, payload, MESSAGE.Rattach);
  }

  walk({ fid, newfid, names = [] }) {
    const writer = createWriter().u32(fid).u32(newfid).u16(names.length);
    for (const name of names) writer.string(name);
    return this.request(MESSAGE.Twalk, writer.build(), MESSAGE.Rwalk);
  }

  open({ fid, mode = 0 }) {
    return this.request(MESSAGE.Topen, createWriter().u32(fid).u8(mode).build(), MESSAGE.Ropen);
  }

  async read({ fid, offset = 0, count = 65536 }) {
    const payload = createWriter().u32(fid).u64(offset).u32(count).build();
    const response = await this.request(MESSAGE.Tread, payload, MESSAGE.Rread);
    const reader = createReader(response.payload);
    const size = reader.u32('read size');
    return Buffer.from(reader.bytes(size, 'read data'));
  }

  async write({ fid, offset = 0, data }) {
    const body = Buffer.from(data);
    const payload = createWriter().u32(fid).u64(offset).u32(body.length).bytes(body).build();
    await this.request(MESSAGE.Twrite, payload, MESSAGE.Rwrite);
    return body.length;
  }

  clunk({ fid }) {
    return this.request(MESSAGE.Tclunk, createWriter().u32(fid).build(), MESSAGE.Rclunk);
  }

  request(type, payload, expectedType) {
    return new Promise((resolve, reject) => {
      const tag = this.nextTag;
      this.nextTag = (this.nextTag + 1) & 0xffff;
      if (this.nextTag === 0) this.nextTag = 1;
      this.pending.set(tag, { resolve, reject, expectedType });
      this.socket.write(encodeMessage(type, tag, payload));
    });
  }

  #handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (this.buffer.length < size) return;
      const raw = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      const message = decodeMessage(raw);
      const pending = this.pending.get(message.tag);
      if (!pending) continue;
      this.pending.delete(message.tag);
      if (message.type === MESSAGE.Rerror) {
        const reader = createReader(message.payload);
        pending.reject(new Error(reader.string('error')));
      } else if (message.type !== pending.expectedType) {
        pending.reject(new Error(`Expected ${pending.expectedType}, received ${message.type}`));
      } else {
        pending.resolve(message);
      }
    }
  }
}

export function readQid(response) {
  return decodeQid(createReader(response.payload));
}
