import WebSocket, { type ClientOptions } from 'ws';
import {
  parseServerMessage,
  type CreateMessage,
  type CreatedMessage,
  type JoinedMessage,
  type ServerMessage,
} from '@test01/protocol';
import { createSyncServer, type SyncServerHandle } from '../src/index.js';

export type MessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

export const FIXTURE_TITLE_URL = 'http://127.0.0.1:8080/fixture.html';

export function createMessage(nickname = 'Host'): CreateMessage {
  return { v: 1, type: 'create', nickname, site: 'fixture', titleUrl: FIXTURE_TITLE_URL };
}

export function startServer(): Promise<SyncServerHandle> {
  return createSyncServer({ port: 0, host: '127.0.0.1' });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** WebSocket test client that records every server frame, validated against the protocol. */
export class TestClient {
  readonly messages: ServerMessage[] = [];
  /** Frames that failed parseServerMessage; tests expect this to stay empty. */
  readonly invalid: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly listeners = new Set<() => void>();

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
        this.notify();
      });
    });
    ws.on('message', (data) => {
      const raw = data.toString();
      const result = parseServerMessage(raw);
      if (result.ok) this.messages.push(result.value);
      else this.invalid.push(`${result.reason}: ${raw}`);
      this.notify();
    });
    ws.on('error', () => {});
  }

  static connect(url: string, options?: ClientOptions): Promise<TestClient> {
    const ws = new WebSocket(url, options);
    const client = new TestClient(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** Index to pass as `from` so waitFor only matches frames received after this point. */
  mark(): number {
    return this.messages.length;
  }

  waitFor<T extends ServerMessage['type']>(
    type: T,
    predicate: (message: MessageOf<T>) => boolean = () => true,
    { timeoutMs = 2000, from = 0 }: { timeoutMs?: number; from?: number } = {},
  ): Promise<MessageOf<T>> {
    return new Promise((resolve, reject) => {
      const find = (): MessageOf<T> | undefined => {
        for (let i = from; i < this.messages.length; i++) {
          const message = this.messages[i]!;
          if (message.type === type && predicate(message as MessageOf<T>)) return message as MessageOf<T>;
        }
        return undefined;
      };
      const found = find();
      if (found) return resolve(found);
      const listener = () => {
        const match = find();
        if (!match) return;
        cleanup();
        resolve(match);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs} ms waiting for '${type}'`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
    });
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export async function createRoom(
  handle: SyncServerHandle,
  nickname = 'Host',
  options?: ClientOptions,
): Promise<{ client: TestClient; created: CreatedMessage }> {
  const client = await TestClient.connect(handle.wsUrl, options);
  client.send(createMessage(nickname));
  const created = await client.waitFor('created');
  return { client, created };
}

export async function joinRoom(
  handle: SyncServerHandle,
  roomId: string,
  secret: string,
  nickname: string,
  options?: ClientOptions,
): Promise<{ client: TestClient; joined: JoinedMessage }> {
  const client = await TestClient.connect(handle.wsUrl, options);
  client.send({ v: 1, type: 'join', roomId, secret, nickname });
  const joined = await client.waitFor('joined');
  return { client, joined };
}

/** Paths of every string (or Buffer decoded as utf8/base64url) inside `root` equal to `needle`. */
export function findValue(root: unknown, needle: string): string[] {
  const hits: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value === needle) hits.push(path);
      return;
    }
    if (Buffer.isBuffer(value)) {
      if (value.toString('utf8') === needle || value.toString('base64url') === needle) hits.push(path);
      return;
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        visit(key, `${path}<key>`);
        visit(entry, `${path}[${String(key)}]`);
      }
      return;
    }
    if (value instanceof Set) {
      for (const entry of value) visit(entry, `${path}<item>`);
      return;
    }
    for (const key of Reflect.ownKeys(value)) visit((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`);
  };
  visit(root, '$');
  return hits;
}
