import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { Doc } from "@tandem/crdt";
import { SyncClient } from "../../web/src/lib/sync.js";
import WebSocket from "ws";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

interface ServerProcess {
  child: ChildProcess;
  port: number;
}

const children: ServerProcess[] = [];

async function startServerProcess(): Promise<ServerProcess> {
  const port = 8300 + children.length;
  // detached so we can signal the whole process group: killing the pnpm wrapper
  // alone leaves the tsx child running and holding the port
  const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL,
      AUTH_SECRET: "crash-test-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const proc = { child, port };
  children.push(proc);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not start")),
      20_000,
    );
    child.stdout?.on("data", (buf: Buffer) => {
      if (buf.toString().includes('"msg":"listening"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early: ${code}`));
    });
  });
  return proc;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// These run against a real child process and real Postgres: an acknowledged op
// must survive SIGKILL because the server acks only after the rows commit.
describe.skipIf(!DATABASE_URL)("crash recovery", () => {
  beforeAll(() => {
    // each run gets a unique board so repeat runs do not see old ops
  });

  afterAll(async () => {
    for (const { child } of children) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  });

  it("loses no acknowledged operation when the server is SIGKILLed", async () => {
    const srv = await startServerProcess();
    const suffix = Date.now();

    const reg = async (
      email: string,
    ): Promise<{ userId: string; token: string }> => {
      const res = await fetch(`http://127.0.0.1:${srv.port}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password123" }),
      });
      expect(res.ok).toBe(true);
      return (await res.json()) as { userId: string; token: string };
    };
    const owner = await reg(`crash-owner-${suffix}@test.local`);
    const breg = await fetch(`http://127.0.0.1:${srv.port}/boards`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.token}`,
      },
      body: "{}",
    });
    const { boardId } = (await breg.json()) as { boardId: string };

    const makeClient = (port: number): { client: SyncClient; doc: Doc } => {
      const doc = new Doc(owner.userId);
      return {
        doc,
        client: new SyncClient({
          doc,
          boardId,
          token: owner.token,
          userId: owner.userId,
          name: "Ana",
          color: "#3355ff",
          url: `ws://127.0.0.1:${port}/ws`,
          socketFactory: (u) =>
            new WebSocket(u) as unknown as globalThis.WebSocket,
        }),
      };
    };

    const { client } = makeClient(srv.port);
    await client.start();
    await waitFor(() => client.status === "open", 10_000, "first client open");

    await client.edit([
      { t: "putObject", objId: `${owner.userId}:1`, type: "rect" },
      { t: "zInsert", objId: `${owner.userId}:1`, parent: null },
    ]);
    // wait for a real ack (the server's state vector covering our ops), not just
    // for the bytes to leave the client
    await waitFor(
      () => client.hasUnackedOps === false,
      10_000,
      "ops acknowledged",
    );
    client.close();

    // hard kill of the whole process group, no graceful shutdown anywhere
    process.kill(-srv.child.pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));

    // restart on a different port against the same database
    const restarted = await startServerProcess();
    const fresh = makeClient(restarted.port);
    await fresh.client.start();
    await waitFor(
      () => fresh.client.status === "open",
      10_000,
      "client open after restart",
    );

    await waitFor(
      () => fresh.doc.shapes().some((s) => s.id === `${owner.userId}:1`),
      10_000,
      "acked op survived the crash",
    );
    fresh.client.close();
  }, 60_000);
});
