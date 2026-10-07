import { z } from "zod";

export const rgaIdSchema = z.object({
  counter: z.number().int().nonnegative(),
  actor: z.string().min(1).max(64),
});

export const valueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("null") }),
  z.object({ kind: z.literal("bool"), v: z.boolean() }),
  z.object({ kind: z.literal("int"), v: z.number().int() }),
  z.object({ kind: z.literal("double"), v: z.number() }),
  z.object({ kind: z.literal("string"), v: z.string().max(64 * 1024) }),
  z.object({
    kind: z.literal("points"),
    v: z.array(z.object({ x: z.number(), y: z.number() })).max(10_000),
  }),
]);

export const opSpecSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("putObject"),
    objId: z.string().min(1).max(256),
    type: z.string().min(1).max(64),
  }),
  z.object({ t: z.literal("deleteObject"), objId: z.string().min(1).max(256) }),
  z.object({
    t: z.literal("restoreObject"),
    objId: z.string().min(1).max(256),
  }),
  z.object({
    t: z.literal("putProp"),
    objId: z.string().min(1).max(256),
    key: z.string().min(1).max(128),
    value: valueSchema,
  }),
  z.object({
    t: z.literal("removeProp"),
    objId: z.string().min(1).max(256),
    key: z.string().min(1).max(128),
  }),
  z.object({
    t: z.literal("zInsert"),
    objId: z.string().min(1).max(256),
    parent: rgaIdSchema.nullable(),
  }),
  z.object({ t: z.literal("zRemove"), objId: z.string().min(1).max(256) }),
  z.object({
    t: z.literal("textInsert"),
    objId: z.string().min(1).max(256),
    id: rgaIdSchema,
    parent: rgaIdSchema.nullable(),
    ch: z.string().min(1).max(4),
  }),
  z.object({
    t: z.literal("textRemove"),
    objId: z.string().min(1).max(256),
    id: rgaIdSchema,
  }),
]);

export const opSchema = z.object({
  seq: z.number().int().positive(),
  wall: z.number().int().nonnegative(),
  logical: z.number().int().nonnegative(),
  actor: z.string().min(1).max(64),
  spec: opSpecSchema,
});

export const helloSchema = z.object({
  protocol: z.literal("tandem/1"),
  token: z.string().min(1).max(4096),
  boardId: z.string().min(1).max(128),
  stateVector: z.record(z.string().max(64), z.number().int().nonnegative()),
});

export const ackSchema = z.object({
  batchId: z.string().min(1).max(64),
  applied: z.number().int().nonnegative(),
  stateVector: z.record(z.string().max(64), z.number().int().nonnegative()),
});

export const presenceSchema = z.object({
  userId: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  cursor: z.object({ x: z.number(), y: z.number() }).optional(),
  selection: z.array(z.string().max(256)).max(64).optional(),
  at: z.number().int().nonnegative(),
});

export const errorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(512),
});
