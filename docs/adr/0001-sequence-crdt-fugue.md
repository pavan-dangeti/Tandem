# ADR 0001: Sequence CRDT — RGA vs Fugue

## Status

Superseded by 0003. Original decision: Fugue.

## Context

Ordered collections — the z-order of shapes and text runs — need a sequence
CRDT so concurrent insertions converge without a central sequencer. The two
serious candidates are RGA (Replicated Growable Array) and Fugue.

## Decision (superseded)

Adopt Fugue for position identifiers.

## Rationale

- RGA interleaves concurrent insertions at the same position in a way that
  can scramble text ("concurrent weave" problem, e.g. typing 'hello' and
  'world' at the same spot can yield 'hweorllod').
- Fugue's identifiers avoid interleaving of concurrent runs, which matters
  for text and also yields more predictable z-ordering when several users
  append shapes concurrently.
- Fugue's walk-based integration is simple to implement and to verify
  against a reference model in property-based tests.

## Consequences

- We maintain a tombstoned identifier tree per ordered collection.
- Encoding of positions is slightly more complex than RGA ids; the binary
  protocol budgets for it and the benchmark reports bytes/op.
