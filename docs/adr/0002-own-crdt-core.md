# ADR 0002: Implement our own CRDT core instead of using Yjs

## Status

Accepted (Phase 0)

## Context

The multiplayer engine could be built on Yjs or Automerge directly, or
implemented from scratch.

## Decision

Implement our own CRDT core in `packages/crdt` (zero runtime dependencies),
and benchmark it honestly against Yjs and Automerge on both a public text
trace and a whiteboard workload.

## Rationale

- The project goal is to own and defend the engine: data types, delta sync,
  GC, per-user undo, binary encoding.
- Yjs/Automerge remain as the baseline in every benchmark; where our
  implementation loses, the README says so.
- Owning the format lets us version the protocol and design Redis fan-out
  around operations rather than document updates.

## Consequences

- We own correctness: property-based tests, model-based tests, chaos tests.
- We lose Yjs's maturity; we compensate with honest benchmarks and
  documented limitations.
