export interface RGAId {
  counter: number;
  actor: string;
}

export function rgaIdKey(id: RGAId): string {
  return `${id.actor}:${id.counter}`;
}

export function rgaCompare(a: RGAId, b: RGAId): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}

import type { HLC } from "./hlc.js";
import { hlcCompare } from "./hlc.js";

interface Node<V> {
  id: RGAId;
  value: V;
  parent: string | null;
  deleted: boolean;
  flagHlc: HLC | null;
}

export class RGA<V> {
  private nodes = new Map<string, Node<V>>();
  private children = new Map<string | null, string[]>();
  private pending = new Map<
    string,
    { id: RGAId; parent: RGAId | null; value: V; hlc?: HLC }[]
  >();
  private pendingDeletes = new Map<string, HLC[]>();

  getValue(id: RGAId): V | undefined {
    const n = this.nodes.get(rgaIdKey(id));
    return n?.value;
  }

  parentOf(id: RGAId): RGAId | null {
    const n = this.nodes.get(rgaIdKey(id));
    if (n === undefined || n.parent === null) return null;
    const i = n.parent.lastIndexOf(":");
    return {
      actor: n.parent.slice(0, i),
      counter: Number(n.parent.slice(i + 1)),
    };
  }

  has(id: RGAId): boolean {
    return this.nodes.has(rgaIdKey(id));
  }

  insert(id: RGAId, parent: RGAId | null, value: V, hlc?: HLC): boolean {
    const key = rgaIdKey(id);
    const existing = this.nodes.get(key);
    if (existing !== undefined) {
      if (
        hlc !== undefined &&
        (existing.flagHlc === null || hlcCompare(hlc, existing.flagHlc) > 0)
      ) {
        existing.flagHlc = hlc;
        existing.deleted = false;
      }
      return false;
    }
    const parentKey = parent === null ? null : rgaIdKey(parent);
    if (parentKey !== null && !this.nodes.has(parentKey)) {
      const list = this.pending.get(parentKey) ?? [];
      list.push({ id, parent, value, ...(hlc !== undefined ? { hlc } : {}) });
      this.pending.set(parentKey, list);
      return true;
    }
    this.place(id, parentKey, value, hlc);
    return true;
  }

  private place(
    id: RGAId,
    parentKey: string | null,
    value: V,
    hlc?: HLC,
  ): void {
    const key = rgaIdKey(id);
    this.nodes.set(key, {
      id,
      value,
      parent: parentKey,
      deleted: false,
      flagHlc: hlc ?? null,
    });
    const intents = this.pendingDeletes.get(key);
    if (intents !== undefined) {
      this.pendingDeletes.delete(key);
      for (const dh of intents) {
        const n = this.nodes.get(key)!;
        if (n.flagHlc === null || hlcCompare(dh, n.flagHlc) > 0) {
          n.deleted = true;
          n.flagHlc = dh;
        }
      }
    }
    const siblings = this.children.get(parentKey) ?? [];
    const kId = this.nodes.get(key)!.id;
    let lo = 0;
    let hi = siblings.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const sId = this.nodes.get(siblings[mid]!)!.id;
      if (rgaCompare(sId, kId) > 0) lo = mid + 1;
      else hi = mid;
    }
    siblings.splice(lo, 0, key);
    this.children.set(parentKey, siblings);
    const waiting = this.pending.get(key);
    if (waiting !== undefined) {
      this.pending.delete(key);
      for (const p of waiting) this.insert(p.id, p.parent, p.value, p.hlc);
    }
  }

  delete(id: RGAId, hlc?: HLC): boolean {
    const n = this.nodes.get(rgaIdKey(id));
    if (n === undefined) {
      const key = rgaIdKey(id);
      if (hlc !== undefined) {
        const list = this.pendingDeletes.get(key) ?? [];
        list.push(hlc);
        this.pendingDeletes.set(key, list);
      }
      return false;
    }
    if (
      n.flagHlc === null ||
      hlc === undefined ||
      hlcCompare(hlc, n.flagHlc) > 0
    ) {
      n.deleted = true;
      n.flagHlc = hlc ?? n.flagHlc;
    }
    return true;
  }

  undelete(id: RGAId, hlc?: HLC): boolean {
    const n = this.nodes.get(rgaIdKey(id));
    if (n === undefined) return false;
    if (
      n.flagHlc === null ||
      hlc === undefined ||
      hlcCompare(hlc, n.flagHlc) > 0
    ) {
      n.deleted = false;
      n.flagHlc = hlc ?? n.flagHlc;
    }
    return true;
  }

  values(): V[] {
    const out: V[] = [];
    const stack = [...(this.children.get(null) ?? [])].reverse();
    while (stack.length > 0) {
      const key = stack.pop()!;
      const n = this.nodes.get(key)!;
      if (!n.deleted) out.push(n.value);
      const kids = this.children.get(key) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
    return out;
  }

  materialize(): { ids: string[]; deleted: string[] } {
    const ids: string[] = [];
    const deleted: string[] = [];
    const stack = [...(this.children.get(null) ?? [])].reverse();
    while (stack.length > 0) {
      const key = stack.pop()!;
      const n = this.nodes.get(key)!;
      ids.push(`${n.deleted ? "!" : ""}${rgaIdKey(n.id)}`);
      const kids = this.children.get(key) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
    for (const n of this.nodes.values())
      if (n.deleted) deleted.push(rgaIdKey(n.id));
    return { ids, deleted };
  }

  entries(): { id: RGAId; value: V; deleted: boolean }[] {
    return [...this.nodes.values()].map((n) => ({
      id: n.id,
      value: n.value,
      deleted: n.deleted,
    }));
  }

  gcDeleted(keep: (id: RGAId) => boolean): void {
    for (const [key, n] of [...this.nodes]) {
      const kids = this.children.get(key);
      if (
        n.deleted &&
        !keep(n.id) &&
        (kids === undefined || kids.length === 0)
      ) {
        this.nodes.delete(key);
        const sib = this.children.get(n.parent);
        if (sib)
          this.children.set(
            n.parent,
            sib.filter((k) => k !== key),
          );
        this.children.delete(key);
      }
    }
  }

  equals(other: RGA<V>): boolean {
    if (this.nodes.size !== other.nodes.size) return false;
    for (const [k, n] of this.nodes) {
      const o = other.nodes.get(k);
      if (o === undefined || o.deleted !== n.deleted || o.parent !== n.parent)
        return false;
    }
    return (
      this.materialize().ids.join("|") === other.materialize().ids.join("|")
    );
  }
}
