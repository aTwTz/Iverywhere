export const MESSAGE = Object.freeze({
  Tversion: 100,
  Rversion: 101,
  Tauth: 102,
  Rauth: 103,
  Tattach: 104,
  Rattach: 105,
  Rerror: 107,
  Tflush: 108,
  Rflush: 109,
  Twalk: 110,
  Rwalk: 111,
  Topen: 112,
  Ropen: 113,
  Tcreate: 114,
  Rcreate: 115,
  Tread: 116,
  Rread: 117,
  Twrite: 118,
  Rwrite: 119,
  Tclunk: 120,
  Rclunk: 121,
  Tremove: 122,
  Rremove: 123,
  Tstat: 124,
  Rstat: 125,
  Twstat: 126,
  Rwstat: 127,
});

export const QID_DIRECTORY = 0x80;
export const NO_FID = 0xffffffff;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function createWriter() {
  const parts = [];
  return {
    u8(value) {
      const buffer = Buffer.allocUnsafe(1);
      buffer.writeUInt8(value, 0);
      parts.push(buffer);
      return this;
    },
    u16(value) {
      const buffer = Buffer.allocUnsafe(2);
      buffer.writeUInt16LE(value, 0);
      parts.push(buffer);
      return this;
    },
    u32(value) {
      const buffer = Buffer.allocUnsafe(4);
      buffer.writeUInt32LE(value, 0);
      parts.push(buffer);
      return this;
    },
    u64(value) {
      const buffer = Buffer.allocUnsafe(8);
      buffer.writeBigUInt64LE(BigInt(value), 0);
      parts.push(buffer);
      return this;
    },
    string(value) {
      const data = Buffer.from(String(value), 'utf8');
      this.u16(data.length);
      parts.push(data);
      return this;
    },
    bytes(value) {
      parts.push(Buffer.from(value));
      return this;
    },
    buffer(value) {
      parts.push(value);
      return this;
    },
    build() {
      return Buffer.concat(parts);
    },
  };
}

export function createReader(buffer) {
  let offset = 0;
  const need = (length, label) => {
    if (offset + length > buffer.length) {
      throw new ProtocolError(`Truncated ${label ?? 'field'} at offset ${offset}`);
    }
  };
  return {
    get offset() {
      return offset;
    },
    remaining() {
      return buffer.length - offset;
    },
    u8(label) {
      need(1, label);
      const value = buffer.readUInt8(offset);
      offset += 1;
      return value;
    },
    u16(label) {
      need(2, label);
      const value = buffer.readUInt16LE(offset);
      offset += 2;
      return value;
    },
    u32(label) {
      need(4, label);
      const value = buffer.readUInt32LE(offset);
      offset += 4;
      return value;
    },
    u64(label) {
      need(8, label);
      const value = buffer.readBigUInt64LE(offset);
      offset += 8;
      return value;
    },
    string(label) {
      const length = this.u16(`${label ?? 'string'} length`);
      need(length, label ?? 'string');
      const value = buffer.toString('utf8', offset, offset + length);
      offset += length;
      return value;
    },
    bytes(length, label) {
      need(length, label);
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      return value;
    },
    done() {
      if (offset !== buffer.length) throw new ProtocolError(`${buffer.length - offset} trailing bytes`);
    },
  };
}

export function encodeMessage(type, tag, payload = Buffer.alloc(0)) {
  const size = 4 + 1 + 2 + payload.length;
  return createWriter()
    .u32(size)
    .u8(type)
    .u16(tag)
    .buffer(payload)
    .build();
}

export function decodeMessage(buffer) {
  if (buffer.length < 7) throw new ProtocolError('Message shorter than header');
  const reader = createReader(buffer);
  const size = reader.u32('message size');
  if (size !== buffer.length) throw new ProtocolError(`Message size ${size} does not match buffer ${buffer.length}`);
  const type = reader.u8('message type');
  const tag = reader.u16('tag');
  const payload = reader.bytes(reader.remaining(), 'payload');
  return { size, type, tag, payload };
}

export function encodeQid({ type, version, path }) {
  return createWriter()
    .u8(type)
    .u32(version)
    .u64(path)
    .build();
}

export function decodeQid(reader) {
  return {
    type: reader.u8('qid type'),
    version: reader.u32('qid version'),
    path: reader.u64('qid path'),
  };
}

export function encodeStat(stat) {
  const writer = createWriter();
  // NOTE: stat size 字段不包含自身两个字节，编码完成后回填。
  // NOTE(en): The stat size field excludes its own two bytes and is patched after encoding.
  writer.u16(0);
  writer.u16(stat.type ?? 0);
  writer.u32(stat.dev ?? 0);
  writer.buffer(encodeQid(stat.qid));
  writer.u32(stat.mode ?? 0);
  writer.u32(stat.atime ?? 0);
  writer.u32(stat.mtime ?? 0);
  writer.u64(stat.length ?? 0);
  writer.string(stat.name ?? '');
  writer.string(stat.uid ?? 'nobody');
  writer.string(stat.gid ?? 'nobody');
  writer.string(stat.muid ?? 'nobody');
  const encoded = writer.build();
  encoded.writeUInt16LE(encoded.length - 2, 0);
  return encoded;
}

export function decodeStat(reader) {
  const size = reader.u16('stat size');
  const end = reader.offset + size;
  if (end > reader.remaining() + reader.offset) throw new ProtocolError('Truncated stat');
  const statReader = createReader(reader.bytes(size, 'stat'));
  const stat = {
    type: statReader.u16('stat type'),
    dev: statReader.u32('stat dev'),
    qid: decodeQid(statReader),
    mode: statReader.u32('stat mode'),
    atime: statReader.u32('stat atime'),
    mtime: statReader.u32('stat mtime'),
    length: statReader.u64('stat length'),
    name: statReader.string('stat name'),
    uid: statReader.string('stat uid'),
    gid: statReader.string('stat gid'),
    muid: statReader.string('stat muid'),
  };
  statReader.done();
  return stat;
}

export function encodeRerror(tag, message) {
  return encodeMessage(MESSAGE.Rerror, tag, createWriter().string(message).build());
}

export function toHex(value) {
  return BigInt(value).toString(16);
}
