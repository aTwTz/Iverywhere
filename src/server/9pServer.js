import net from 'node:net';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { AuditLog } from '../audit/auditLog.js';
import { Policy } from '../security/policy.js';
import { Journal } from '../tx/journal.js';
import { SnapshotStore } from '../tx/snapshotStore.js';
import { TransactionManager } from '../tx/transactionManager.js';
import { VirtualFileSystem } from '../vfs/virtualFileSystem.js';
import {
  createReader,
  createWriter,
  decodeMessage,
  decodeQid,
  encodeMessage,
  encodeQid,
  encodeRerror,
  encodeStat,
  MESSAGE,
  NO_FID,
} from './protocol.js';

const OTRUNC = 0x10;

export class IverywhereServer {
  constructor({ config, rootDir }) {
    this.config = config;
    this.rootDir = rootDir;
    this.maxMessageSize = Number(config.server.maxMessageSize ?? 1048576);
    this.policy = new Policy({
      mounts: config.mounts ?? {},
      defaultMount: config.server.defaultMount ?? 'operator',
      writeGrantMs: config.security?.writeGrantMs,
    });
    this.registry = config.registry;
    this.journal = new Journal({ dataDir: config.server.dataDir });
    this.snapshots = new SnapshotStore({
      dataDir: config.server.dataDir,
      retentionLimit: config.snapshots?.retentionLimit,
    });
    this.audit = new AuditLog({ dataDir: config.server.dataDir });
    this.transactions = new TransactionManager({
      registry: this.registry,
      journal: this.journal,
      snapshots: this.snapshots,
      deadlineMs: config.transactions?.deadlineMs,
      queueWaitMs: config.transactions?.queueWaitMs,
    });
    this.vfs = undefined;
    this.server = undefined;
    this.sessions = new Set();
  }

  async start() {
    await this.registry.init();
    this.vfs = new VirtualFileSystem({
      registry: this.registry,
      transactions: this.transactions,
      snapshots: this.snapshots,
      audit: this.audit,
      policy: this.policy,
      sensitiveKeys: this.config.audit?.sensitiveKeys ?? ['token', 'secret', 'password', 'privateKey'],
    });
    const transport = this.config.server.transport ?? 'unix';
    this.server = net.createServer((socket) => this.#handleConnection(socket));

    if (transport === 'unix') {
      const socketPath = path.resolve(this.rootDir, this.config.server.unixSocket ?? './run/iverywhere.sock');
      await mkdir(path.dirname(socketPath), { recursive: true });
      await rm(socketPath, { force: true });
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(socketPath, resolve);
      });
      this.socketPath = socketPath;
      this.address = socketPath;
      return this;
    }

    if (transport !== 'tcp') throw new Error(`Unsupported transport: ${transport}`);
    const host = this.config.server.host ?? '127.0.0.1';
    const port = Number(this.config.server.port ?? 5640);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolve);
    });
    const address = this.server.address();
    this.port = address.port;
    this.address = `${host}:${address.port}`;
    return this;
  }

  async stop() {
    for (const session of [...this.sessions]) session.socket.destroy();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = undefined;
    }
    if (this.socketPath) await rm(this.socketPath, { force: true });
  }

  #handleConnection(socket) {
    const session = {
      socket,
      buffer: Buffer.alloc(0),
      versioned: false,
      msize: 65536,
      fids: new Map(),
      user: 'unknown',
      mount: undefined,
    };
    this.sessions.add(session);
    socket.on('data', (chunk) => {
      session.buffer = Buffer.concat([session.buffer, chunk]);
      this.#drain(session);
    });
    socket.on('close', () => this.sessions.delete(session));
    socket.on('error', () => this.sessions.delete(session));
  }

  #drain(session) {
    while (session.buffer.length >= 4) {
      const size = session.buffer.readUInt32LE(0);
      if (size < 7 || size > this.maxMessageSize) {
        session.socket.destroy();
        return;
      }
      if (session.buffer.length < size) return;
      const raw = session.buffer.subarray(0, size);
      session.buffer = session.buffer.subarray(size);
      let message;
      try {
        message = decodeMessage(raw);
        Promise.resolve(this.#handle(session, message))
          .then((response) => {
            if (response) this.#send(session.socket, response);
          })
          .catch((error) => {
            this.#send(session.socket, encodeRerror(message.tag, toPublicError(error)));
          });
      } catch (error) {
        const tag = message?.tag ?? 0xffff;
        this.#send(session.socket, encodeRerror(tag, toPublicError(error)));
      }
    }
  }

  #handle(session, message) {
    switch (message.type) {
      case MESSAGE.Tversion:
        return this.#version(session, message);
      case MESSAGE.Tauth:
        return encodeRerror(message.tag, 'authentication not required; use mount profile authorization');
      case MESSAGE.Tattach:
        return this.#attach(session, message);
      case MESSAGE.Twalk:
        return this.#walk(session, message);
      case MESSAGE.Topen:
        return this.#open(session, message);
      case MESSAGE.Tread:
        return this.#read(session, message);
      case MESSAGE.Twrite:
        return this.#write(session, message);
      case MESSAGE.Tclunk:
        return this.#clunk(session, message);
      case MESSAGE.Tstat:
        return this.#stat(session, message);
      case MESSAGE.Tflush:
        return encodeMessage(MESSAGE.Rflush, message.tag);
      case MESSAGE.Tcreate:
      case MESSAGE.Tremove:
      case MESSAGE.Twstat:
        return encodeRerror(message.tag, 'operation is disabled in the controlled namespace');
      default:
        return encodeRerror(message.tag, `unsupported message type ${message.type}`);
    }
  }

  #version(session, message) {
    const reader = createReader(message.payload);
    const msize = reader.u32('msize');
    const version = reader.string('version');
    reader.done();
    if (version !== '9P2000') return encodeRerror(message.tag, `unsupported version ${version}`);
    session.versioned = true;
    session.msize = Math.min(msize, this.maxMessageSize);
    session.fids.clear();
    const payload = createWriter()
      .u32(session.msize)
      .string('9P2000')
      .build();
    return encodeMessage(MESSAGE.Rversion, message.tag, payload);
  }

  #attach(session, message) {
    const reader = createReader(message.payload);
    const fid = reader.u32('fid');
    const afid = reader.u32('afid');
    const uname = reader.string('uname');
    const aname = reader.string('aname');
    reader.u32('unused');
    reader.done();
    if (!session.versioned) return encodeRerror(message.tag, 'Tversion required before Tattach');
    if (afid !== NO_FID) return encodeRerror(message.tag, 'authentication fids are not supported');
    const mount = this.policy.attach(aname);
    session.mount = mount;
    session.user = uname || 'unknown';
    session.fids.set(fid, { node: this.vfs.root, mode: 0 });
    return encodeMessage(MESSAGE.Rattach, message.tag, encodeQid(this.vfs.root.qid));
  }

  async #walk(session, message) {
    const reader = createReader(message.payload);
    const fid = reader.u32('fid');
    const newfid = reader.u32('newfid');
    const count = reader.u16('nwname');
    const names = [];
    for (let index = 0; index < count; index += 1) names.push(reader.string(`name ${index}`));
    reader.done();
    const source = session.fids.get(fid);
    if (!source) return encodeRerror(message.tag, `unknown fid ${fid}`);
    if (session.fids.has(newfid)) return encodeRerror(message.tag, `fid ${newfid} already in use`);

    if (names.length === 0) {
      session.fids.set(newfid, { node: source.node, mode: source.mode });
      return encodeMessage(MESSAGE.Rwalk, message.tag, createWriter().u16(0).build());
    }

    const qids = [];
    let current = source.node;
    try {
      for (const name of names) {
        const nextPath = current.path === '/' ? `/${name}` : `${current.path}/${name}`;
        current = await this.vfs.lookup(nextPath, session.mount);
        qids.push(current.qid);
      }
      session.fids.set(newfid, { node: current, mode: 0 });
      const payload = createWriter();
      payload.u16(qids.length);
      for (const qid of qids) payload.buffer(encodeQid(qid));
      return encodeMessage(MESSAGE.Rwalk, message.tag, payload.build());
    } catch (error) {
      const payload = createWriter();
      payload.u16(qids.length);
      for (const qid of qids) payload.buffer(encodeQid(qid));
      const response = encodeMessage(MESSAGE.Rwalk, message.tag, payload.build());
      return response;
    }
  }

  #open(session, message) {
    const reader = createReader(message.payload);
    const fid = reader.u32('fid');
    const mode = reader.u8('mode');
    reader.done();
    const entry = session.fids.get(fid);
    if (!entry) return encodeRerror(message.tag, `unknown fid ${fid}`);
    if (!this.vfs.canOpen(entry.node, mode, session.mount)) {
      return encodeRerror(message.tag, `open mode ${mode} is not allowed for ${entry.node.path}`);
    }
    entry.mode = mode;
    const payload = createWriter()
      .buffer(encodeQid(entry.node.qid))
      .u32(0)
      .build();
    return encodeMessage(MESSAGE.Ropen, message.tag, payload);
  }

  async #read(session, message) {
    const reader = createReader(message.payload);
    const fid = reader.u32('fid');
    const offset = reader.u64('offset');
    const count = reader.u32('count');
    reader.done();
    const entry = session.fids.get(fid);
    if (!entry) return encodeRerror(message.tag, `unknown fid ${fid}`);
    if ((entry.mode & 0x0f) !== 0) return encodeRerror(message.tag, 'fid is not open for reading');

    try {
      const data = entry.node.dir
        ? await this.vfs.readDirectoryData(entry.node, session.mount)
        : await this.vfs.readFile(entry.node, session.mount);
      const start = Math.min(Number(offset), data.length);
      const body = data.subarray(start, Math.min(data.length, start + count));
      await this.audit.append({
        action: 'read',
        mount: session.mount?.name ?? 'unknown',
        user: session.user,
        path: entry.node.path,
        offset: start,
        bytes: body.length,
      });
      return encodeMessage(MESSAGE.Rread, message.tag, createWriter().u32(body.length).bytes(body).build());
    } catch (error) {
      return encodeRerror(message.tag, toPublicError(error));
    }
  }

  async #write(session, message) {
    const reader = createReader(message.payload);
    const fid = reader.u32('fid');
    const offset = reader.u64('offset');
    const count = reader.u32('count');
    const data = reader.bytes(count, 'data');
    reader.done();
    const entry = session.fids.get(fid);
    if (!entry) return encodeRerror(message.tag, `unknown fid ${fid}`);
    if (entry.node.dir) return encodeRerror(message.tag, 'cannot write a directory');
    if ((entry.mode & 0x0f) === 0) return encodeRerror(message.tag, 'fid is not open for writing');
    if ((entry.mode & 0x0f) === 3) return encodeRerror(message.tag, 'execute-only opens are not supported');
    if (Number(offset) !== 0) return encodeRerror(message.tag, 'state-changing writes must replace the whole file at offset 0');

    try {
      const written = await this.vfs.writeFile(entry.node, session.mount, data, { user: session.user });
      return encodeMessage(MESSAGE.Rwrite, message.tag, createWriter().u32(written).build());
    } catch (error) {
      return encodeRerror(message.tag, toPublicError(error));
    }
  }

  #clunk(session, message) {
    const reader = createReader(message.payload);
    const fid = reader.u32('fid');
    reader.done();
    if (!session.fids.delete(fid)) return encodeRerror(message.tag, `unknown fid ${fid}`);
    return encodeMessage(MESSAGE.Rclunk, message.tag);
  }

  #stat(session, message) {
    const reader = createReader(message.payload);
    const fid = reader.u32('fid');
    reader.done();
    const entry = session.fids.get(fid);
    if (!entry) return encodeRerror(message.tag, `unknown fid ${fid}`);
    const encoded = encodeStat(this.vfs.stat(entry.node, session.mount));
    const payload = createWriter()
      .u16(encoded.length)
      .buffer(encoded)
      .build();
    return encodeMessage(MESSAGE.Rstat, message.tag, payload);
  }

  #send(socket, message) {
    socket.write(message);
  }
}

function toPublicError(error) {
  return error?.message ? error.message : String(error);
}
