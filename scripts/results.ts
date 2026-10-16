// Renders the README's result tables from the committed results/*.json, so
// every figure in the README traces back to a file a script wrote.
//
//   pnpm results    prints the tables to paste into README.md
import fs from "node:fs";

interface Stat {
  mean: number;
  ci95: number;
}

interface EngineResult {
  authorMs: Stat;
  mergeMs: Stat;
  memoryMB: Stat;
  bytes: number;
}

interface Bench {
  results: Record<"text" | "whiteboard", Record<string, EngineResult>>;
}

interface ScalePoint {
  boards: number;
  editorsPerBoard: number;
  p50: number;
  p95: number;
  p95Range: [number, number];
  p99: number;
  incomplete: number;
  runs: {
    editsPerSec: number;
    workerCpuPercent: number;
    nodes: { cpuPercent: number; rssMB: number }[];
  }[];
}

interface ColdLoad {
  history: { ops: number };
  slo: { ms: number };
  results: Record<string, { ms: Stat; opsSentToClient: number }>;
}

interface Chaos {
  phases: {
    name: string;
    detail: string;
    converged: boolean;
    lostOps: number;
  }[];
}

const read = <T>(name: string): T =>
  JSON.parse(
    fs.readFileSync(new URL(`../results/${name}`, import.meta.url), "utf8"),
  ) as T;

const ms = (x: number): string =>
  x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(1);
const withCi = (s: Stat, f: (x: number) => string): string =>
  `${f(s.mean)} ± ${f(s.ci95)}`;
const mb = (x: number): string => x.toFixed(1);
const NAMES: Record<string, string> = {
  tandem: "Tandem",
  yjs: "Yjs",
  automerge: "Automerge",
};

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function crdtTable(workload: "text" | "whiteboard"): string {
  const engines = read<Bench>("bench.json").results[workload];
  return table(
    ["Engine", "Author (ms)", "Merge (ms)", "Memory (MB)", "Encoded (MB)"],
    Object.entries(engines).map(([name, r]) => [
      NAMES[name] ?? name,
      withCi(r.authorMs, ms),
      withCi(r.mergeMs, ms),
      withCi(r.memoryMB, mb),
      (r.bytes / 2 ** 20).toFixed(2),
    ]),
  );
}

function scaleTable(): string {
  const { points } = read<{ points: ScalePoint[] }>("scale.json");
  return table(
    [
      "Boards × editors",
      "Edits/s",
      "p50 (ms)",
      "p95 (ms) [range]",
      "p99 (ms)",
      "CPU per node",
      "RSS per node",
      "CPU per editor worker",
      "Undelivered",
    ],
    points.map((p) => {
      const nodes = p.runs.flatMap((r) => r.nodes);
      return [
        `${p.boards} × ${p.editorsPerBoard}`,
        String(Math.max(...p.runs.map((r) => r.editsPerSec))),
        ms(p.p50),
        `${ms(p.p95)} [${ms(p.p95Range[0])}–${ms(p.p95Range[1])}]`,
        ms(p.p99),
        `≤ ${Math.max(...nodes.map((n) => n.cpuPercent))}%`,
        `≤ ${Math.max(...nodes.map((n) => n.rssMB))} MB`,
        `≤ ${Math.max(...p.runs.map((r) => r.workerCpuPercent))}%`,
        String(p.incomplete),
      ];
    }),
  );
}

function summaryTable(): string {
  const bench = read<Bench>("bench.json").results;
  const scale = read<{ slo: { p95Ms: number }; points: ScalePoint[] }>(
    "scale.json",
  );
  const cold = read<ColdLoad>("coldload.json");
  const chaos = read<Chaos>("chaos.json");
  const oneBoard = scale.points.filter((p) => p.boards === 1);
  const at50 = oneBoard.find((p) => p.editorsPerBoard === 50)!;
  const firstBreach = oneBoard.find((p) => p.p95 >= scale.slo.p95Ms);
  const lastPass = [...oneBoard]
    .reverse()
    .find(
      (p) =>
        p.p95 < scale.slo.p95Ms &&
        (!firstBreach || p.editorsPerBoard < firstBreach.editorsPerBoard),
    )!;
  const snap = Object.entries(cold.results).find(([k]) =>
    k.startsWith("snapshot"),
  )![1];
  const logOnly = cold.results["log only"]!;
  const t = bench.text;
  const w = bench.whiteboard;
  const x = (a: number, b: number): string => `${(a / b).toFixed(1)}×`;
  return table(
    ["Measure", "Tandem", "Baseline", "Method", "Reproduce"],
    [
      [
        "Text trace, author 259,778 edits",
        `${ms(t.tandem!.authorMs.mean)} ms`,
        `Yjs ${ms(t.yjs!.authorMs.mean)} ms (${x(t.tandem!.authorMs.mean, t.yjs!.authorMs.mean)} faster), Automerge ${ms(t.automerge!.authorMs.mean)} ms`,
        "automerge-perf trace, 5 fresh processes, mean",
        "`pnpm --filter @tandem/crdt bench`",
      ],
      [
        "Whiteboard, merge 100k ops into an empty replica",
        `${ms(w.tandem!.mergeMs.mean)} ms`,
        `Yjs ${ms(w.yjs!.mergeMs.mean)} ms, Automerge ${ms(w.automerge!.mergeMs.mean)} ms`,
        "seeded create/move/delete stream",
        "`pnpm --filter @tandem/crdt bench`",
      ],
      [
        "Whiteboard, encoded size",
        `${(w.tandem!.bytes / 2 ** 20).toFixed(2)} MB`,
        `Yjs ${(w.yjs!.bytes / 2 ** 20).toFixed(2)} MB, Automerge ${(w.automerge!.bytes / 2 ** 20).toFixed(2)} MB`,
        "Tandem: per-op wire encoding; others: document encoding",
        "`pnpm --filter @tandem/crdt bench`",
      ],
      [
        "p95 edit-to-remote, 50 editors on one board",
        `${ms(at50.p95)} ms`,
        `target < ${scale.slo.p95Ms} ms`,
        "2 nodes + Redis + Postgres, 2 edits/s per editor, 3 runs, median",
        "`pnpm --filter @tandem/server bench`",
      ],
      [
        "Most editors on one board within the p95 target",
        `${lastPass.editorsPerBoard}`,
        firstBreach
          ? `breaks at ${firstBreach.editorsPerBoard} (p95 ${ms(firstBreach.p95)} ms)`
          : "not reached in the sweep",
        "same sweep",
        "`pnpm --filter @tandem/server bench`",
      ],
      [
        `Cold load, ${cold.history.ops.toLocaleString("en-US")}-op board`,
        `${ms(snap.ms.mean)} ms`,
        `log replay ${ms(logOnly.ms.mean)} ms; target < ${cold.slo.ms.toLocaleString("en-US")} ms`,
        "fresh server process, new client until fully applied, 5 runs",
        "`pnpm --filter @tandem/server coldload`",
      ],
      [
        "Ops lost under network chaos",
        String(chaos.phases.reduce((n, p) => n + p.lostOps, 0)),
        `${chaos.phases.length} phases: ${chaos.phases.map((p) => p.name).join(", ")}`,
        "toxiproxy between clients and server, then heal",
        "`pnpm --filter @tandem/server chaos`",
      ],
    ],
  );
}

function chaosTable(): string {
  return table(
    ["Phase", "Condition", "Converged", "Lost ops"],
    read<Chaos>("chaos.json").phases.map((p) => [
      p.name,
      p.detail,
      p.converged ? "yes" : "**no**",
      String(p.lostOps),
    ]),
  );
}

export function resultTables(): Record<string, string> {
  return {
    summary: summaryTable(),
    "CRDT, text trace": crdtTable("text"),
    "CRDT, whiteboard": crdtTable("whiteboard"),
    scale: scaleTable(),
    chaos: chaosTable(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`)
  for (const [name, t] of Object.entries(resultTables()))
    console.log(`<!-- ${name} -->\n${t}\n`);
