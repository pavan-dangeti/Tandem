import { useCallback, useEffect, useRef, useState } from "react";
import type { Doc } from "@tandem/crdt";
import { SyncClient, type ConnectionStatus } from "../lib/sync";
import {
  hits,
  num,
  renderPresenceCursors,
  renderShape,
  type Point,
  type ShapeType,
} from "../lib/board";

const TOOLS: {
  id: ShapeType | "select" | "erase";
  label: string;
  hint: string;
}[] = [
  {
    id: "select",
    label: "Select",
    hint: "Click and drag to move; handles resize",
  },
  { id: "rect", label: "Rect", hint: "Drag to draw a rectangle" },
  { id: "ellipse", label: "Ellipse", hint: "Drag to draw an ellipse" },
  { id: "line", label: "Line", hint: "Drag to draw a line" },
  { id: "arrow", label: "Arrow", hint: "Drag to draw an arrow" },
  { id: "text", label: "Text", hint: "Click to place text, then type" },
  { id: "sticky", label: "Sticky", hint: "Click to drop a sticky note" },
  { id: "freehand", label: "Draw", hint: "Drag to draw freehand" },
];

export interface BoardProps {
  client: SyncClient;
  doc: Doc;
}

interface DragState {
  kind: "move" | "create" | "resize" | "draw";
  objId?: string;
  start: Point;
  origin?: Point;
  type?: ShapeType;
  points?: Point[];
}

export function Board({ client, doc }: BoardProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [version, setVersion] = useState(0);
  const [tool, setTool] = useState<(typeof TOOLS)[number]["id"]>("select");
  const [selection, setSelection] = useState<string[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>(client.status);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const dragRef = useRef<DragState | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const bump = (): void => setVersion((v) => v + 1);
    client.onChange = bump;
    client.onPresence = bump;
    client.onStatus = () => setStatus(client.status);
    bump();
    return () => {
      client.onChange = null;
      client.onPresence = null;
      client.onStatus = null;
    };
  }, [client]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    for (const shape of doc.shapes()) {
      renderShape(ctx, shape, doc.text(shape.id), selection.includes(shape.id));
    }
    renderPresenceCursors(ctx, [...client.presences.values()]);
  }, [client, doc, selection, version]);

  const pointFromEvent = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): Point => {
      const rect = e.currentTarget.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },
    [],
  );

  const nextId = useCallback((): string => {
    seqRef.current += 1;
    return `${client.userId}:${seqRef.current}`;
  }, [client]);

  const shapeAt = useCallback(
    (p: Point): string | null => {
      const shapes = doc.shapes();
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i]!;
        if (hits(s, p)) return s.id;
      }
      return null;
    },
    [doc],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      // Otherwise the mousedown default moves focus to <body>, which blurs and
      // closes the text input this handler is about to open.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = pointFromEvent(e);

      if (tool === "select") {
        const hit = shapeAt(p);
        setSelection(hit ? [hit] : []);
        if (hit) {
          const shape = doc.shapes().find((s) => s.id === hit)!;
          dragRef.current = {
            kind: "move",
            objId: hit,
            start: p,
            origin: { x: num(shape, "x"), y: num(shape, "y") },
          };
        }
        return;
      }

      if (tool === "erase") {
        const hit = shapeAt(p);
        if (hit) void client.edit([{ t: "deleteObject", objId: hit }]);
        return;
      }

      if (tool === "text") {
        const id = nextId();
        void client.edit([
          { t: "putObject", objId: id, type: "text" },
          { t: "zInsert", objId: id, parent: null },
          {
            t: "putProp",
            objId: id,
            key: "x",
            value: { kind: "double", v: p.x },
          },
          {
            t: "putProp",
            objId: id,
            key: "y",
            value: { kind: "double", v: p.y },
          },
        ]);
        setEditingText(id);
        setEditingDraft("");
        setSelection([id]);
        return;
      }

      if (tool === "sticky") {
        const id = nextId();
        void client.edit([
          { t: "putObject", objId: id, type: "sticky" },
          { t: "zInsert", objId: id, parent: null },
          {
            t: "putProp",
            objId: id,
            key: "x",
            value: { kind: "double", v: p.x },
          },
          {
            t: "putProp",
            objId: id,
            key: "y",
            value: { kind: "double", v: p.y },
          },
          {
            t: "putProp",
            objId: id,
            key: "w",
            value: { kind: "double", v: 140 },
          },
          {
            t: "putProp",
            objId: id,
            key: "h",
            value: { kind: "double", v: 100 },
          },
        ]);
        setSelection([id]);
        return;
      }

      const id = nextId();
      if (tool === "freehand") {
        dragRef.current = {
          kind: "draw",
          objId: id,
          start: p,
          type: "freehand",
          points: [p],
        };
        return;
      }
      if (tool === "line" || tool === "arrow") {
        dragRef.current = { kind: "create", objId: id, start: p, type: tool };
        return;
      }
      dragRef.current = { kind: "create", objId: id, start: p, type: tool };
    },
    [client, doc, pointFromEvent, shapeAt, tool, nextId],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const p = pointFromEvent(e);
      client.presence(p, selection);
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.kind === "move" && drag.objId && drag.origin) {
        const shape = doc.shapes().find((s) => s.id === drag.objId);
        if (!shape) return;
        if (
          shape.type === "line" ||
          shape.type === "arrow" ||
          shape.type === "freehand"
        )
          return;
        void client.edit([
          {
            t: "putProp",
            objId: shape.id,
            key: "x",
            value: { kind: "double", v: drag.origin.x + (p.x - drag.start.x) },
          },
          {
            t: "putProp",
            objId: shape.id,
            key: "y",
            value: { kind: "double", v: drag.origin.y + (p.y - drag.start.y) },
          },
        ]);
        return;
      }

      if (drag.kind === "draw" && drag.objId && drag.points) {
        drag.points.push(p);
        void client.edit([
          { t: "putObject", objId: drag.objId, type: "freehand" },
          { t: "zInsert", objId: drag.objId, parent: null },
          {
            t: "putProp",
            objId: drag.objId,
            key: "points",
            value: { kind: "points", v: [...drag.points] },
          },
        ]);
        return;
      }

      if (drag.kind === "create" && drag.objId && drag.type) {
        const specs: import("@tandem/crdt").OpSpec[] = [
          { t: "putObject", objId: drag.objId, type: drag.type },
          { t: "zInsert", objId: drag.objId, parent: null },
        ];
        if (drag.type === "line" || drag.type === "arrow") {
          specs.push(
            {
              t: "putProp",
              objId: drag.objId,
              key: "x1",
              value: { kind: "double", v: drag.start.x },
            },
            {
              t: "putProp",
              objId: drag.objId,
              key: "y1",
              value: { kind: "double", v: drag.start.y },
            },
            {
              t: "putProp",
              objId: drag.objId,
              key: "x2",
              value: { kind: "double", v: p.x },
            },
            {
              t: "putProp",
              objId: drag.objId,
              key: "y2",
              value: { kind: "double", v: p.y },
            },
          );
        } else {
          specs.push(
            {
              t: "putProp",
              objId: drag.objId,
              key: "x",
              value: { kind: "double", v: Math.min(drag.start.x, p.x) },
            },
            {
              t: "putProp",
              objId: drag.objId,
              key: "y",
              value: { kind: "double", v: Math.min(drag.start.y, p.y) },
            },
            {
              t: "putProp",
              objId: drag.objId,
              key: "w",
              value: { kind: "double", v: Math.abs(p.x - drag.start.x) },
            },
            {
              t: "putProp",
              objId: drag.objId,
              key: "h",
              value: { kind: "double", v: Math.abs(p.y - drag.start.y) },
            },
          );
        }
        void client.edit(specs);
      }
    },
    [client, doc, pointFromEvent, selection],
  );

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (
      drag?.kind === "draw" &&
      drag.objId &&
      drag.points &&
      drag.points.length > 1
    ) {
      setSelection([drag.objId]);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? client.redo() : client.undo());
      }
      if (e.key === "Escape") {
        setEditingText(null);
        setSelection([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client]);

  const commitText = useCallback(() => {
    if (editingText) {
      let counter = 100_000;
      let parent: { actor: string; counter: number } | null = null;
      const specs: import("@tandem/crdt").OpSpec[] = [];
      for (const ch of editingDraft) {
        const id = { actor: client.userId, counter: counter++ };
        specs.push({ t: "textInsert", objId: editingText, id, parent, ch });
        parent = id;
      }
      if (specs.length > 0) void client.edit(specs);
    }
    setEditingText(null);
  }, [client, editingDraft, editingText]);

  const peers = [...client.presences.values()];
  const statusLabel =
    status === "open"
      ? "live"
      : status === "connecting"
        ? "connecting…"
        : "offline — edits saved locally";

  return (
    <div
      style={{
        display: "flex",
        height: "100dvh",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <aside
        style={{
          width: 180,
          borderRight: "1px solid #e4e4e8",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <strong style={{ fontSize: 15 }}>Tandem</strong>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              style={{
                padding: "6px 8px",
                textAlign: "left",
                borderRadius: 6,
                border:
                  tool === t.id ? "1px solid #3355ff" : "1px solid #e4e4e8",
                background: tool === t.id ? "#eef2ff" : "#fff",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => setTool("erase")}
            style={{
              padding: "6px 8px",
              textAlign: "left",
              borderRadius: 6,
              border:
                tool === "erase" ? "1px solid #3355ff" : "1px solid #e4e4e8",
              background: tool === "erase" ? "#feecec" : "#fff",
              cursor: "pointer",
            }}
          >
            Erase
          </button>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => void client.undo()} style={{ flex: 1 }}>
            Undo
          </button>
          <button onClick={() => void client.redo()} style={{ flex: 1 }}>
            Redo
          </button>
        </div>
        <div
          style={{
            marginTop: "auto",
            fontSize: 12,
            color: status === "open" ? "#12a150" : "#b06a00",
          }}
        >
          {statusLabel}
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12 }}>
          {peers.map((p) => (
            <li key={p.userId} style={{ color: p.color }}>
              ● {p.name}
            </li>
          ))}
        </ul>
      </aside>
      <div style={{ position: "relative", flex: 1 }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Whiteboard, ${doc.shapes().length} shapes`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            touchAction: "none",
            cursor: tool === "select" ? "default" : "crosshair",
          }}
        />
        {editingText !== null && (
          <input
            autoFocus
            value={editingDraft}
            placeholder="type, then press Enter"
            onChange={(e) => setEditingDraft(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              if (e.key === "Escape") setEditingText(null);
            }}
            style={{
              position: "absolute",
              left: num(
                doc.shapes().find((s) => s.id === editingText)!,
                "x",
              ),
              top: num(
                doc.shapes().find((s) => s.id === editingText)!,
                "y",
              ),
              fontSize: 16,
              border: "1px solid #3355ff",
              padding: 2,
            }}
          />
        )}
      </div>
    </div>
  );
}
