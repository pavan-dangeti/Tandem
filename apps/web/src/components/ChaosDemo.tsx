import { useCallback, useEffect, useRef, useState } from "react";
import { Doc } from "@tandem/crdt";
import { SyncClient, type ConnectionStatus } from "../lib/sync.js";
import { colorFor, renderShape } from "../lib/board.js";

// Demo of the headline property: two people edit the same board, one goes
// offline mid-edit, and both converge when the network returns. Each simulated
// user connects with its own share token, so each is a distinct CRDT actor.
interface Actor {
  name: string;
  client: SyncClient;
  doc: Doc;
  color: string;
  offline: boolean;
  status: ConnectionStatus;
}

const API = import.meta.env.VITE_API ?? "http://localhost:8080";

export function ChaosDemo({ token }: { token: string }): React.JSX.Element {
  const [actors, setActors] = useState<Actor[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [converged, setConverged] = useState<boolean | null>(null);
  const starting = useRef(false);

  const note = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-6), line]);
  }, []);

  const start = useCallback(async () => {
    if (starting.current) return;
    starting.current = true;
    const made: Actor[] = [];
    // a throwaway board of its own: the demo must not scribble on the board the
    // user is actually working in
    const created = await fetch(`${API}/boards`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    const boardId = ((await created.json()) as { boardId: string }).boardId;
    for (const name of ["Ana", "Ben"]) {
      const res = await fetch(`${API}/boards/${boardId}/share`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role: "editor", ttlSeconds: 3600 }),
      });
      const { token: shareToken } = (await res.json()) as { token: string };
      // a placeholder actor: the server names the real one in its handshake
      const doc = new Doc(`pending-${name}`);
      const client = new SyncClient({
        doc,
        boardId,
        token: shareToken,
        userId: `pending-${name}`,
        name,
        color: colorFor(name),
        url: `${API.replace(/^http/, "ws")}/ws`,
      });
      clients.current.push(client);
      client.onStatus = () =>
        setActors((prev) =>
          prev.map((a) =>
            a.client === client ? { ...a, status: client.status } : a,
          ),
        );
      await client.start();
      made.push({
        name,
        client,
        doc,
        color: colorFor(name),
        offline: false,
        status: client.status,
      });
    }
    setActors(made);
    note("both editors connected");
  }, [note, token]);

  // Clients are tracked in a ref, not closed off the actors array: a status
  // update replaces that array on every render, and closing on it would kill
  // the very clients that just reported in.
  const clients = useRef<SyncClient[]>([]);
  useEffect(() => {
    const live = clients.current;
    return () => {
      for (const c of live) c.close();
    };
  }, []);

  const goOffline = useCallback(
    (index: number, seconds: number) => {
      const actor = actors[index];
      if (!actor) return;
      actor.offline = true;
      setActors([...actors]);
      note(`${actor.name} lost the network`);
      // their edits keep working locally; the client reconnects on its own
      (actor.client as unknown as { ws: WebSocket | null }).ws?.close();
      setTimeout(() => {
        note(`${actor.name} is back online`);
        actor.offline = false;
        setActors([...actors]);
      }, seconds * 1000);
    },
    [actors, note],
  );

  const drawWhileOffline = useCallback(
    (index: number) => {
      const actor = actors[index];
      if (!actor) return;
      const id = `${actor.client.userId}:${Math.floor(Math.random() * 1e6)}`;
      const x = 20 + Math.random() * 240;
      const y = 20 + Math.random() * 140;
      void actor.client.edit([
        { t: "putObject", objId: id, type: "rect" },
        { t: "zInsert", objId: id, parent: null },
        { t: "putProp", objId: id, key: "x", value: { kind: "double", v: x } },
        { t: "putProp", objId: id, key: "y", value: { kind: "double", v: y } },
        { t: "putProp", objId: id, key: "w", value: { kind: "double", v: 80 } },
        { t: "putProp", objId: id, key: "h", value: { kind: "double", v: 60 } },
      ]);
      note(
        `${actor.name} drew a rectangle while ${actor.offline ? "offline" : "online"}`,
      );
    },
    [actors, note],
  );

  const compare = useCallback(() => {
    if (actors.length < 2) return;
    const canon = (doc: Doc): string =>
      JSON.stringify(
        doc
          .shapes()
          .map((s) => ({
            ...s,
            props: Object.fromEntries(Object.entries(s.props).sort()),
          }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
    const [ana, ben] = [actors[0]!.doc, actors[1]!.doc];
    const counts = `${actors[0]!.name}: ${ana.shapes().length} shapes, ${actors[1]!.name}: ${ben.shapes().length} shapes`;
    const same = canon(ana) === canon(ben);
    setConverged(same);
    if (same) {
      note(`replicas converged (${counts})`);
      return;
    }
    const only = (a: Doc, b: Doc): string =>
      a
        .shapes()
        .map((s) => s.id)
        .filter((id) => !b.shapes().some((o) => o.id === id))
        .join(", ");
    const [missA, missB] = [only(ana, ben), only(ben, ana)];
    note(
      `replicas differ (${counts}); only ${actors[0]!.name} has: ${missA || "nothing"}; only ${actors[1]!.name} has: ${missB || "nothing"}`,
    );
  }, [actors, note]);

  return (
    <div
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        padding: 16,
      }}
    >
      <h2 style={{ fontSize: 18, marginTop: 0 }}>
        Chaos demo: two editors, one loses the network
      </h2>
      <p style={{ color: "#555", fontSize: 14, maxWidth: 620 }}>
        Each simulated editor is a separate CRDT actor connected with its own
        share token. Cut one connection, keep drawing, then let it reconnect:
        the CRDT merges the offline work and both replicas end up identical.
      </p>
      <div
        style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
      >
        <button onClick={() => void start()}>Start two editors</button>
        {actors.map((a, i) => (
          <span
            key={a.name}
            style={{ display: "flex", gap: 6, alignItems: "center" }}
          >
            <button onClick={() => drawWhileOffline(i)}>{a.name}: draw</button>
            <button onClick={() => goOffline(i, 8)}>
              {a.name}: cut network 8s
            </button>
          </span>
        ))}
        {actors.length === 2 && (
          <button onClick={compare}>
            {converged === null
              ? "Compare replicas"
              : converged
                ? "Converged ✓"
                : "Not converged ✗"}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {actors.map((a) => (
          <MiniBoard
            key={a.name}
            doc={a.doc}
            color={a.color}
            label={`${a.name} - ${a.status}`}
          />
        ))}
        {actors.length === 0 && (
          <p style={{ color: "#777" }}>No editors yet.</p>
        )}
      </div>
      <ul style={{ fontSize: 13, color: "#444", marginTop: 16 }}>
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function MiniBoard({
  doc,
  color,
  label,
}: {
  doc: Doc;
  color: string;
  label: string;
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const shape of doc.shapes())
      renderShape(ctx, shape, doc.text(shape.id), false);
  });

  return (
    <div>
      <div style={{ fontSize: 13, color, marginBottom: 4 }}>● {label}</div>
      <canvas
        ref={ref}
        width={320}
        height={200}
        style={{
          border: "1px solid #e4e4e8",
          borderRadius: 6,
          background: "#fff",
        }}
      />
    </div>
  );
}
