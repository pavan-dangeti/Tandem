import type { Shape } from "@tandem/crdt";

export interface Point {
  x: number;
  y: number;
}

export const SHAPE_TYPES = [
  "rect",
  "ellipse",
  "line",
  "arrow",
  "text",
  "sticky",
  "freehand",
] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

export function num(shape: Shape, key: string, fallback = 0): number {
  const v = shape.props[key];
  return v && v.kind === "double"
    ? v.v
    : v && v.kind === "int"
      ? v.v
      : fallback;
}

function pointsOf(shape: Shape): Point[] {
  const v = shape.props["points"];
  return v && v.kind === "points" ? v.v : [];
}

function bounds(shape: Shape): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const x = num(shape, "x");
  const y = num(shape, "y");
  switch (shape.type) {
    case "line":
    case "arrow":
      return {
        x: Math.min(num(shape, "x1"), num(shape, "x2")),
        y: Math.min(num(shape, "y1"), num(shape, "y2")),
        w: Math.abs(num(shape, "x2") - num(shape, "x1")),
        h: Math.abs(num(shape, "y2") - num(shape, "y1")),
      };
    case "freehand": {
      const pts = pointsOf(shape);
      if (pts.length === 0) return { x, y, w: 0, h: 0 };
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
    }
    default:
      return { x, y, w: num(shape, "w"), h: num(shape, "h") };
  }
}

export function hits(shape: Shape, p: Point, tolerance = 6): boolean {
  const b = bounds(shape);
  if (shape.type === "line" || shape.type === "arrow") {
    return (
      distanceToSegment(
        p,
        { x: num(shape, "x1"), y: num(shape, "y1") },
        { x: num(shape, "x2"), y: num(shape, "y2") },
      ) <= tolerance
    );
  }
  if (shape.type === "freehand") {
    const pts = pointsOf(shape);
    for (let i = 1; i < pts.length; i++) {
      if (distanceToSegment(p, pts[i - 1]!, pts[i]!) <= tolerance) return true;
    }
    return false;
  }
  return (
    p.x >= b.x - tolerance &&
    p.x <= b.x + b.w + tolerance &&
    p.y >= b.y - tolerance &&
    p.y <= b.y + b.h + tolerance
  );
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const PALETTE = [
  "#3355ff",
  "#e0483f",
  "#12a150",
  "#a352e8",
  "#e08b17",
  "#0aa3b5",
];

export function colorFor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++)
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function renderShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  text: string,
  selected: boolean,
): void {
  const x = num(shape, "x");
  const y = num(shape, "y");
  ctx.lineWidth = 2;
  ctx.strokeStyle = selected ? "#3355ff" : "#1b1b1f";
  ctx.fillStyle = selected ? "rgba(51,85,255,0.08)" : "#1b1b1f";

  switch (shape.type) {
    case "rect":
      ctx.beginPath();
      ctx.roundRect(x, y, num(shape, "w"), num(shape, "h"), 4);
      ctx.stroke();
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(
        x + num(shape, "w") / 2,
        y + num(shape, "h") / 2,
        num(shape, "w") / 2,
        num(shape, "h") / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    case "line":
    case "arrow": {
      ctx.beginPath();
      ctx.moveTo(num(shape, "x1"), num(shape, "y1"));
      ctx.lineTo(num(shape, "x2"), num(shape, "y2"));
      ctx.stroke();
      if (shape.type === "arrow") {
        const angle = Math.atan2(
          num(shape, "y2") - num(shape, "y1"),
          num(shape, "x2") - num(shape, "x1"),
        );
        ctx.beginPath();
        ctx.moveTo(num(shape, "x2"), num(shape, "y2"));
        ctx.lineTo(
          num(shape, "x2") - 12 * Math.cos(angle - Math.PI / 6),
          num(shape, "y2") - 12 * Math.sin(angle - Math.PI / 6),
        );
        ctx.moveTo(num(shape, "x2"), num(shape, "y2"));
        ctx.lineTo(
          num(shape, "x2") - 12 * Math.cos(angle + Math.PI / 6),
          num(shape, "y2") - 12 * Math.sin(angle + Math.PI / 6),
        );
        ctx.stroke();
      }
      break;
    }
    case "freehand": {
      const pts = pointsOf(shape);
      if (pts.length > 1) {
        ctx.beginPath();
        ctx.moveTo(pts[0]!.x, pts[0]!.y);
        for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else if (pts.length === 1) {
        ctx.fillRect(pts[0]!.x - 1, pts[0]!.y - 1, 2, 2);
      }
      break;
    }
    case "sticky": {
      ctx.fillStyle = "#ffe89a";
      ctx.beginPath();
      ctx.roundRect(x, y, num(shape, "w") || 120, num(shape, "h") || 120, 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.fillStyle = "#1b1b1f";
      ctx.font = "16px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "top";
      text.split("\n").forEach((line, i) => ctx.fillText(line, x, y + i * 20));
      break;
    }
  }

  if (selected) {
    const b = bounds(shape);
    ctx.strokeStyle = "#3355ff";
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
    ctx.setLineDash([]);
  }
}

export function renderPresenceCursors(
  ctx: CanvasRenderingContext2D,
  presences: { userId: string; name: string; color: string; cursor?: Point }[],
): void {
  for (const p of presences) {
    if (!p.cursor) continue;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(p.cursor.x, p.cursor.y);
    ctx.lineTo(p.cursor.x + 12, p.cursor.y + 4);
    ctx.lineTo(p.cursor.x + 4, p.cursor.y + 12);
    ctx.closePath();
    ctx.fill();
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(p.name, p.cursor.x + 14, p.cursor.y + 12);
  }
}
