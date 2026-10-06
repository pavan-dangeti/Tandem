import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Doc } from "../src/index.js";
import type { Op } from "../src/index.js";
import { encodeOp } from "../src/index.js";
import * as Y from "yjs";
import * as A from "@automerge/automerge";

const WOB_OPS = 100_000;

interface OpStream {
  edits: [number, number, string][];
  finalText: string;
}

function loadTrace(): OpStream {
  const src = fs.readFileSync(
    new URL("./editing-trace.js", import.meta.url),
    "utf8",
  );
  const moduleShim = { exports: {} as OpStream };
  new Function("module", "exports", src)(moduleShim, moduleShim);
  return moduleShim.exports;
}

function memoryMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function now(): number {
  return performance.now();
}

async function benchText(): Promise<Record<string, unknown>> {
  const { edits: allEdits, finalText } = loadTrace();
  const edits = allEdits.slice(
    0,
    Number(process.env.WOB_TRACE ?? allEdits.length),
  );
  const fullText = edits.length === allEdits.length ? finalText : undefined;
  // tandem CRDT
  {
    const doc = new Doc("u1");
    const ops: Op[] = [];
    ops.push(
      ...doc.applyLocal([
        { t: "putObject", objId: "u1:1", type: "text" },
        { t: "zInsert", objId: "u1:1", parent: null },
      ]),
    );
    const positions: {
      id: { actor: string; counter: number };
      alive: boolean;
    }[] = [];
    let textCounter = 1;
    const m0 = memoryMB();
    const t0 = now();
    for (const [index, delCount, insertedRaw] of edits) {
      const inserted = insertedRaw ?? "";
      for (let d = 0; d < delCount; d++) {
        const p = positions[index]!;
        ops.push(
          ...doc.applyLocal([{ t: "textRemove", objId: "u1:1", id: p.id }]),
        );
        p.alive = false;
        positions.splice(index, 1);
      }
      for (let i = 0; i < inserted.length; i++) {
        const id = { actor: "u1", counter: textCounter++ };
        const parent = index + i > 0 ? positions[index + i - 1]!.id : null;
        ops.push(
          ...doc.applyLocal([
            { t: "textInsert", objId: "u1:1", id, parent, ch: inserted[i]! },
          ]),
        );
        positions.splice(index + i, 0, { id, alive: true });
      }
    }
    const tandemAuthor = now() - t0;
    const m1 = memoryMB();
    console.log("tandem author done ms", now() - t0);
    const final = doc.text("u1:1");
    if (fullText !== undefined && final !== fullText)
      throw new Error(
        `tandem final mismatch: ${final.length} vs ${fullText.length}`,
      );
    const bytes = ops.reduce((n, o) => n + encodeOp(o).length, 0);
    const doc2 = new Doc("u2");
    const mt0 = now();
    doc2.merge(ops);
    const tandemMerge = now() - mt0;
    // save to temp for reuse in JSON write
    lastText["tandem"] = {
      authorMs: tandemAuthor,
      mergeMs: tandemMerge,
      memAfterMB: m1 - m0,
      bytes,
      ops: ops.length,
      finalLength: final.length,
    };
  }
  // Yjs
  {
    const doc = new Y.Doc();
    const t = doc.getText("text");
    const m0 = memoryMB();
    const t0 = now();
    for (const [index, delCount, inserted] of edits) {
      if (delCount > 0) t.delete(index, delCount);
      const ins0 = inserted ?? "";
      if (ins0.length > 0) t.insert(index, ins0);
    }
    const author = now() - t0;
    console.log("stage done ms", author);
    const m1 = memoryMB();
    if (fullText !== undefined && t.toString() !== fullText)
      throw new Error("yjs final mismatch");
    const bytes = Y.encodeStateAsUpdate(doc).byteLength;
    const doc2 = new Y.Doc();
    const mt0 = now();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
    const merge = now() - mt0;
    lastText["yjs"] = {
      authorMs: author,
      mergeMs: merge,
      memAfterMB: m1 - m0,
      bytes,
      ops: edits.length,
      finalLength: fullText?.length ?? 0,
    };
  }
  // Automerge
  {
    let doc = A.init<{ text: string }>();
    doc = A.change(doc, (d) => {
      d.text = "";
    });
    const m0 = memoryMB();
    const t0 = now();
    for (const [index, delCount, inserted] of edits) {
      const ins = inserted ?? "";
      doc = A.change(doc, (d) => {
        if (delCount > 0) A.splice(d, ["text"], index, delCount);
        if (ins.length > 0) A.splice(d, ["text"], index, 0, ins);
      });
    }
    const author = now() - t0;
    console.log("stage done ms", author);
    const m1 = memoryMB();
    if (fullText !== undefined && doc.text !== fullText)
      throw new Error("automerge final mismatch");
    const bytes = A.save(doc).byteLength;
    const mt0 = now();
    A.load<typeof doc>(A.save(doc)); /* merge proxy */
    const merge = now() - mt0;
    lastText["automerge"] = {
      authorMs: author,
      mergeMs: merge,
      memAfterMB: m1 - m0,
      bytes,
      ops: edits.length,
      finalLength: fullText?.length ?? 0,
    };
  }
  const editsCount = edits.length;
  return { editsCount, ...lastText };
}

const lastText: Record<string, unknown> = {};

function wobOps(): {
  actor: string;
  kind: string;
  objId?: string;
  key?: string;
  value?: number;
}[] {
  let s = 0x9e3779b9;
  const rand = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  const out: {
    actor: string;
    kind: string;
    objId?: string;
    key?: string;
    value?: number;
  }[] = [];
  let n = 0;
  for (let i = 0; i < WOB_OPS; i++) {
    const r = rand();
    if (r < 0.125 && n > 10) {
      out.push({
        actor: "u1",
        kind: "delete",
        objId: `u1:${(1 + rand() * n) | 0}`,
      });
    } else if (r < 0.25) {
      n++;
      out.push({ actor: "u1", kind: "create", objId: `u1:${n}` });
    } else {
      out.push({
        actor: "u1",
        kind: "move",
        objId: `u1:${(1 + rand() * n) | 0}`,
        value: rand(),
      });
    }
  }
  return out;
}

async function benchWhiteboard(): Promise<Record<string, unknown>> {
  const stream = wobOps();
  // tandem
  {
    const doc = new Doc("u1");
    const ops: Op[] = [];
    const m0 = memoryMB();
    const t0 = now();
    for (const s of stream) {
      if (s.kind === "create")
        ops.push(
          ...doc.applyLocal([
            { t: "putObject", objId: s.objId!, type: "rect" },
            { t: "zInsert", objId: s.objId!, parent: null },
          ]),
        );
      else if (s.kind === "move")
        ops.push(
          ...doc.applyLocal([
            {
              t: "putProp",
              objId: s.objId!,
              key: "x",
              value: { kind: "double", v: s.value! },
            },
          ]),
        );
      else
        ops.push(...doc.applyLocal([{ t: "deleteObject", objId: s.objId! }]));
    }
    const author = now() - t0;
    console.log("stage done ms", author);
    const m1 = memoryMB();
    const bytes = ops.reduce((n, o) => n + encodeOp(o).length, 0);
    const doc2 = new Doc("u2");
    const mt0 = now();
    doc2.merge(ops);
    const merge = now() - mt0;
    lastWob["tandem"] = {
      authorMs: author,
      mergeMs: merge,
      memAfterMB: m1 - m0,
      bytes,
      ops: ops.length,
    };
  }
  // Yjs
  {
    const doc = new Y.Doc();
    const objs = doc.getMap("objects");
    let n = 0;
    const m0 = memoryMB();
    const t0 = now();
    for (const s of stream) {
      if (s.kind === "create") {
        n++;
        objs.set(`u1:${n}`, { type: "rect", x: 0 });
      } else if (s.kind === "move") {
        const cur = objs.get(s.objId!) as object | undefined;
        if (cur) objs.set(s.objId!, { ...cur, x: s.value! });
      } else {
        objs.delete(s.objId!);
      }
    }
    const author = now() - t0;
    console.log("stage done ms", author);
    const m1 = memoryMB();
    const bytes = Y.encodeStateAsUpdate(doc).byteLength;
    const doc2 = new Y.Doc();
    const mt0 = now();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
    const merge = now() - mt0;
    lastWob["yjs"] = {
      authorMs: author,
      mergeMs: merge,
      memAfterMB: m1 - m0,
      bytes,
      ops: stream.length,
    };
  }
  // Automerge
  {
    let doc = A.init<{
      objects: Record<string, { type: string; x: number }>;
    }>();
    doc = A.change(doc, (d) => {
      d.objects = {};
    });
    let n = 0;
    const m0 = memoryMB();
    const t0 = now();
    for (const s of stream) {
      doc = A.change(doc, (d) => {
        if (s.kind === "create")
          d.objects[`u1:${++n}`] = { type: "rect", x: 0 };
        else if (s.kind === "move") {
          const o = d.objects[s.objId!];
          if (o) o.x = s.value!;
        } else delete d.objects[s.objId!];
      });
    }
    const author = now() - t0;
    console.log("stage done ms", author);
    const m1 = memoryMB();
    const bytes = A.save(doc).byteLength;
    const mt0 = now();
    A.load<typeof doc>(A.save(doc)); /* merge proxy */
    const merge = now() - mt0;
    lastWob["automerge"] = {
      authorMs: author,
      mergeMs: merge,
      memAfterMB: m1 - m0,
      bytes,
      ops: stream.length,
    };
  }
  return { opsCount: stream.length, ...lastWob };
}

const lastWob: Record<string, unknown> = {};

async function main(): Promise<void> {
  console.log("text trace...");
  const text = await benchText();
  console.log(JSON.stringify(text, null, 2));
  console.log("whiteboard...");
  const wob = await benchWhiteboard();
  console.log(JSON.stringify(wob, null, 2));
  const out = {
    date: new Date().toISOString(),
    hardware: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 1024 ** 3)}GB RAM, node ${process.version}`,
    text,
    whiteboard: wob,
  };
  fs.mkdirSync(new URL("../../../results", import.meta.url), {
    recursive: true,
  });
  fs.writeFileSync(
    new URL("../../../results/bench.json", import.meta.url),
    JSON.stringify(out, null, 2) + "\n",
  );
  console.log("wrote results/bench.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
