import { randomBytes } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export interface FanoutMessage {
  /** node that persisted the ops, so it can skip its own broadcast */
  origin: string;
  boardId: string;
  /** encoded ops, already validated by the persisting node */
  ops: Uint8Array[];
}

/**
 * Cross-node op fan-out. Nodes are otherwise stateless: whoever accepts a batch
 * persists it, publishes it here, and every other node applies it to its local
 * board session and forwards it to its own connected clients.
 */
export interface Bus {
  readonly id: string;
  publish(msg: FanoutMessage): Promise<void>;
  subscribe(handler: (msg: FanoutMessage) => void): Promise<void>;
  close(): Promise<void>;
}

/** Single-node deployments run without Redis; fan-out stays in-process. */
export class LocalBus implements Bus {
  readonly id = randomBytes(6).toString("hex");
  private handlers: ((msg: FanoutMessage) => void)[] = [];

  async publish(msg: FanoutMessage): Promise<void> {
    for (const h of this.handlers) h(msg);
  }

  async subscribe(handler: (msg: FanoutMessage) => void): Promise<void> {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.handlers = [];
  }
}

export class RedisBus implements Bus {
  readonly id = randomBytes(6).toString("hex");
  private client: RedisClientType;
  private sub: RedisClientType;
  private handlers: ((msg: FanoutMessage) => void)[] = [];

  constructor(url: string) {
    this.client = createClient({ url });
    this.sub = this.client.duplicate();
  }

  /** Connect both clients, turning any failure into a startup error. */
  static async create(url: string): Promise<RedisBus> {
    const bus = new RedisBus(url);
    await bus.connect();
    return bus;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.sub.connect();
  }

  async publish(msg: FanoutMessage): Promise<void> {
    await this.client.publish(
      `tandem:board:${msg.boardId}`,
      JSON.stringify({
        origin: msg.origin,
        boardId: msg.boardId,
        ops: msg.ops.map((o) => Buffer.from(o).toString("base64")),
      }),
    );
  }

  async subscribe(handler: (msg: FanoutMessage) => void): Promise<void> {
    this.handlers.push(handler);
    // node-redis invokes subscriber callbacks as (message, channel)
    await this.sub.pSubscribe("tandem:board:*", (raw, key) => {
      void key;
      const parsed = JSON.parse(raw) as {
        origin: string;
        boardId: string;
        ops: string[];
      };
      const msg: FanoutMessage = {
        origin: parsed.origin,
        boardId: parsed.boardId,
        ops: parsed.ops.map((o) => new Uint8Array(Buffer.from(o, "base64"))),
      };
      for (const h of this.handlers) h(msg);
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.sub.quit(), this.client.quit()]);
  }
}
