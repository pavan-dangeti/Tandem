// Benchmarks this CRDT against Yjs and Automerge on two workloads:
//   text       — the automerge-perf editing trace (259,778 single-character
//                edits that wrote an academic paper), github.com/automerge/automerge-perf
//   whiteboard — 100,000 seeded create/move/delete operations on shapes
// Every engine x workload x repeat runs in a fresh process: Automerge's WASM
// memory never shrinks, and a fresh process keeps JIT state from leaking
// between engines. Writes results/bench.json.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import * as A from "@automerge/automerge";
import * as Y from "yjs";
import { Doc, encodeOp, type Op } from "../src/index.js";

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const WHITEBOARD_OPS = 100_000;
const WHITEBOARD_SEED = 0x9e3779b9;
const ENGINES = ["tandem", "yjs", "automerge"] as const;
const WORKLOADS = ["text", "whiteboard"] as const;
type Engine = (typeof ENGINES)[number];
type Workload = (typeof WORKLOADS)[number];

interface Sample {
  authorMs: number;
  mergeMs: number;
  memoryMB: number;
  bytes: number;
}

// Heap plus external memory after a full GC; external includes WASM memory.
function liveMB(): number {
  globalThis.gc!();
  const m = process.memoryUsage();
  return (m.heapUsed + m.external) / 2 ** 20;
}

function timed<T>(f: () => T): [T, number] {
  const t0 = performance.now();
  const out = f();
  return [out, performance.now() - t0];
}

function loadTrace(): {
  edits: [number, number, string?][];
  finalText: string;
} {
  const src = fs.readFileSync(
    new URL("./editing-trace.js", import.meta.url),
    "utf8",
  );
  const mod = {
    exports: {} as { edits: [number, number, string?][]; finalText: string },
  };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

type ShapeOp =
  | { kind: "create"; id: string }
  | { kind: "move"; id: string; x: number }
  | { kind: "delete"; id: string };

function whiteboardOps(): ShapeOp[] {
  let s = WHITEBOARD_SEED;
  const rand = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  const out: ShapeOp[] = [];
  let n = 0;
  const pick = (): string => `u1:${(1 + rand() * n) | 0}`;
  for (let i = 0; i < WHITEBOARD_OPS; i++) {
    const r = rand();
    if (r < 0.125 && n > 10) out.push({ kind: "delete", id: pick() });
    else if (r < 0.25) out.push({ kind: "create", id: `u1:${++n}` });
    else out.push({ kind: "move", id: pick(), x: rand() });
  }
  return out;
}

// "merge" = bring an empty replica up to date with the authored document.
// Bytes: Yjs and Automerge encode the whole document; tandem has no document
// encoding, so it is the sum of its per-op wire encodings (what sync sends).
function tandemText(): Sample {
  const { edits, finalText } = loadTrace();
  const doc = new Doc("u1");
  const m0 = liveMB();
  const [, authorMs] = timed(() => {
    doc.applyLocal([
      { t: "putObject", objId: "t", type: "text" },
      { t: "zInsert", objId: "t", parent: null },
    ]);
    const ids: { actor: string; counter: number }[] = [];
    let counter = 1;
    for (const [index, del, ins = ""] of edits) {
      for (let d = 0; d < del; d++)
        doc.applyLocal([{ t: "textRemove", objId: "t", id: ids[index + d]! }]);
      ids.splice(index, del);
      for (let i = 0; i < ins.length; i++) {
        const id = { actor: "u1", counter: counter++ };
        const parent = index + i > 0 ? ids[index + i - 1]! : null;
        doc.applyLocal([
          { t: "textInsert", objId: "t", id, parent, ch: ins[i]! },
        ]);
        ids.splice(index + i, 0, id);
      }
    }
  });
  const memoryMB = liveMB() - m0;
  if (doc.text("t") !== finalText) throw new Error("tandem: wrong final text");
  const ops: Op[] = doc.opList;
  const bytes = ops.reduce((n, o) => n + encodeOp(o).length, 0);
  const [, mergeMs] = timed(() => new Doc("u2").merge(ops));
  return { authorMs, mergeMs, memoryMB, bytes };
}

function yjsText(): Sample {
  const { edits, finalText } = loadTrace();
  const doc = new Y.Doc();
  const text = doc.getText("t");
  const m0 = liveMB();
  const [, authorMs] = timed(() => {
    for (const [index, del, ins = ""] of edits) {
      if (del > 0) text.delete(index, del);
      if (ins) text.insert(index, ins);
    }
  });
  const memoryMB = liveMB() - m0;
  if (text.toString() !== finalText) throw new Error("yjs: wrong final text");
  const update = Y.encodeStateAsUpdate(doc);
  const [, mergeMs] = timed(() => Y.applyUpdate(new Y.Doc(), update));
  return { authorMs, mergeMs, memoryMB, bytes: update.byteLength };
}

function automergeText(): Sample {
  const { edits, finalText } = loadTrace();
  let doc = A.from<{ t: string }>({ t: "" });
  const m0 = liveMB();
  const [, authorMs] = timed(() => {
    for (const [index, del, ins = ""] of edits)
      doc = A.change(doc, (d) => A.splice(d, ["t"], index, del, ins));
  });
  const memoryMB = liveMB() - m0;
  if (doc.t !== finalText) throw new Error("automerge: wrong final text");
  const saved = A.save(doc);
  const [, mergeMs] = timed(() => A.load(saved));
  return { authorMs, mergeMs, memoryMB, bytes: saved.byteLength };
}

function tandemWhiteboard(): Sample {
  const stream = whiteboardOps();
  const doc = new Doc("u1");
  const m0 = liveMB();
  const [, authorMs] = timed(() => {
    for (const op of stream) {
      if (op.kind === "create")
        doc.applyLocal([
          { t: "putObject", objId: op.id, type: "rect" },
          { t: "zInsert", objId: op.id, parent: null },
        ]);
      else if (op.kind === "move")
        doc.applyLocal([
          {
            t: "putProp",
            objId: op.id,
            key: "x",
            value: { kind: "double", v: op.x },
          },
        ]);
      else doc.applyLocal([{ t: "deleteObject", objId: op.id }]);
    }
  });
  const memoryMB = liveMB() - m0;
  const ops = doc.opList;
  const bytes = ops.reduce((n, o) => n + encodeOp(o).length, 0);
  const [, mergeMs] = timed(() => new Doc("u2").merge(ops));
  return { authorMs, mergeMs, memoryMB, bytes };
}

// Each shape is a nested map, so a move updates one property, as in tandem.
function yjsWhiteboard(): Sample {
  const stream = whiteboardOps();
  const doc = new Y.Doc();
  const shapes = doc.getMap<Y.Map<unknown>>("shapes");
  const m0 = liveMB();
  const [, authorMs] = timed(() => {
    for (const op of stream) {
      if (op.kind === "create") {
        const shape = new Y.Map<unknown>();
        shapes.set(op.id, shape);
        shape.set("type", "rect");
      } else if (op.kind === "move") shapes.get(op.id)?.set("x", op.x);
      else shapes.delete(op.id);
    }
  });
  const memoryMB = liveMB() - m0;
  const update = Y.encodeStateAsUpdate(doc);
  const [, mergeMs] = timed(() => Y.applyUpdate(new Y.Doc(), update));
  return { authorMs, mergeMs, memoryMB, bytes: update.byteLength };
}

function automergeWhiteboard(): Sample {
  const stream = whiteboardOps();
  let doc = A.from<{ shapes: Record<string, { type: string; x?: number }> }>({
    shapes: {},
  });
  const m0 = liveMB();
  const [, authorMs] = timed(() => {
    for (const op of stream)
      doc = A.change(doc, (d) => {
        if (op.kind === "create") d.shapes[op.id] = { type: "rect" };
        else if (op.kind === "move") {
          const s = d.shapes[op.id];
          if (s) s.x = op.x;
        } else Reflect.deleteProperty(d.shapes, op.id);
      });
  });
  const memoryMB = liveMB() - m0;
  const saved = A.save(doc);
  const [, mergeMs] = timed(() => A.load(saved));
  return { authorMs, mergeMs, memoryMB, bytes: saved.byteLength };
}

const RUNNERS: Record<Workload, Record<Engine, () => Sample>> = {
  text: { tandem: tandemText, yjs: yjsText, automerge: automergeText },
  whiteboard: {
    tandem: tandemWhiteboard,
    yjs: yjsWhiteboard,
    automerge: automergeWhiteboard,
  },
};

// Two-sided 95% Student t critical values, indexed by degrees of freedom.
const T95 = [NaN, 12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26];

function summarize(xs: number[]): { mean: number; ci95: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, ci95: NaN };
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  return { mean, ci95: ((T95[n - 1] ?? 1.96) * sd) / Math.sqrt(n) };
}

// Read from node_modules: Automerge's "exports" map does not expose package.json.
function version(pkg: string): string {
  const file = new URL(`../node_modules/${pkg}/package.json`, import.meta.url);
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string })
    .version;
}

function child(workload: Workload, engine: Engine): Sample {
  const r = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      "--expose-gc",
      "--max-old-space-size=8192",
      fileURLToPath(import.meta.url),
      workload,
      engine,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (r.status !== 0) throw new Error(`${workload}/${engine} failed`);
  return JSON.parse(r.stdout) as Sample;
}

function main(): void {
  const versions = {
    yjs: version("yjs"),
    automerge: version("@automerge/automerge"),
  };
  const results: Record<string, Record<string, unknown>> = {};
  for (const workload of WORKLOADS) {
    const byEngine: Record<string, unknown> = {};
    for (const engine of ENGINES) {
      const samples: Sample[] = [];
      for (let i = 0; i < RUNS; i++) samples.push(child(workload, engine));
      const stat = (k: keyof Sample) => summarize(samples.map((s) => s[k]));
      byEngine[engine] = {
        authorMs: stat("authorMs"),
        mergeMs: stat("mergeMs"),
        memoryMB: stat("memoryMB"),
        bytes: samples[0]!.bytes,
        samples,
      };
      console.error(
        `${workload}/${engine}: author ${stat("authorMs").mean.toFixed(0)} ms`,
      );
    }
    results[workload] = byEngine;
  }
  const out = {
    date: new Date().toISOString(),
    hardware: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)}GB RAM, ${os.platform()} ${os.release()}, node ${process.version}`,
    versions,
    runs: RUNS,
    whiteboard: { ops: WHITEBOARD_OPS, seed: WHITEBOARD_SEED },
    text: {
      trace: "automerge-perf paper trace",
      edits: loadTrace().edits.length,
    },
    results,
  };
  fs.writeFileSync(
    new URL("../../../results/bench.json", import.meta.url),
    JSON.stringify(out, null, 2) + "\n",
  );
  console.error("wrote results/bench.json");
}

const [workload, engine] = process.argv.slice(2) as [Workload?, Engine?];
if (workload && engine)
  process.stdout.write(JSON.stringify(RUNNERS[workload][engine]()));
else main();
