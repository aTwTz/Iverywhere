import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReader,
  createWriter,
  decodeMessage,
  decodeStat,
  encodeMessage,
  encodeStat,
  MESSAGE,
  ProtocolError,
} from '../src/server/protocol.js';

test('writer and reader round-trip scalar and string fields', () => {
  const encoded = createWriter()
    .u8(7)
    .u16(513)
    .u32(98765)
    .u64(2n ** 40n)
    .string('中文路径')
    .build();
  const reader = createReader(encoded);
  assert.equal(reader.u8(), 7);
  assert.equal(reader.u16(), 513);
  assert.equal(reader.u32(), 98765);
  assert.equal(reader.u64(), 2n ** 40n);
  assert.equal(reader.string(), '中文路径');
  assert.equal(reader.remaining(), 0);
});

test('message encode/decode preserves type, tag and payload', () => {
  const payload = createWriter().string('hello').build();
  const encoded = encodeMessage(MESSAGE.Rversion, 42, payload);
  const decoded = decodeMessage(encoded);
  assert.equal(decoded.type, MESSAGE.Rversion);
  assert.equal(decoded.tag, 42);
  assert.equal(decoded.payload.toString('utf8'), payload.toString('utf8'));
});

test('malformed message size is rejected', () => {
  const encoded = encodeMessage(MESSAGE.Rversion, 1, createWriter().build());
  encoded.writeUInt32LE(encoded.length + 1, 0);
  assert.throws(() => decodeMessage(encoded), ProtocolError);
});

test('stat encode/decode round-trip', () => {
  const stat = {
    type: 1,
    dev: 2,
    qid: { type: 0x80, version: 3, path: 99n },
    mode: 0x800001ed,
    atime: 10,
    mtime: 20,
    length: 123n,
    name: 'demo',
    uid: 'operator',
    gid: 'iverywhere',
    muid: 'operator',
  };
  const decoded = decodeStat(createReader(encodeStat(stat)));
  assert.deepEqual(decoded, stat);
});
