/**
 * Minimal JSON-schema → Zod bridge.
 *
 * `Step.extract.schema` is a small JSON-schema object (e.g. `{ type: "string" }`
 * or `{ type: "object", properties: {...} }`). `extractFromPage` and output
 * validation both want a Zod schema, so this converts the common subset. Unknown
 * / unsupported shapes degrade to `z.unknown()` rather than throwing — validation
 * is a best-effort correctness signal, not a gate that should crash a run.
 */

import { z } from "zod";

type JsonSchema = Record<string, unknown>;

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.unknown();
  const s = schema as JsonSchema;

  if (Array.isArray(s.enum)) {
    const values = s.enum.filter((v): v is string => typeof v === "string");
    if (values.length) return z.enum(values as [string, ...string[]]);
  }

  switch (s.type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(jsonSchemaToZod(s.items));
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, sub] of Object.entries(props)) {
        const zsub = jsonSchemaToZod(sub);
        shape[key] = required.has(key) ? zsub : zsub.optional();
      }
      return z.object(shape).passthrough();
    }
    default:
      return z.unknown();
  }
}

/**
 * OpenAI structured outputs (response_format json_schema) require the ROOT
 * schema to be `type: "object"` — a scalar/array root like `{ type: "string" }`
 * is rejected by the provider. Wrap any non-object-root extract schema in a
 * `{ value: <declared> }` envelope for the model call, and return the matching
 * `unwrap` that lifts `.value` back out so the flow's output key still receives
 * the plain scalar (never `{value: …}`). Object-root schemas pass through
 * unchanged with an identity unwrap.
 */
export function envelopeForExtraction(schema: unknown): {
  schema: JsonSchema;
  unwrap: (value: unknown) => unknown;
} {
  const s = (schema && typeof schema === "object" ? schema : {}) as JsonSchema;
  if (s.type === "object") return { schema: s, unwrap: (value) => value };
  return {
    schema: { type: "object", properties: { value: s }, required: ["value"], additionalProperties: false },
    unwrap: (value) =>
      value && typeof value === "object" && "value" in (value as Record<string, unknown>)
        ? (value as Record<string, unknown>).value
        : value,
  };
}

export interface Validation {
  ok: boolean;
  value: unknown;
  error?: string;
}

/** Validate a value against a JSON-schema. `ok:false` never throws. */
export function validateAgainst(schema: unknown, value: unknown): Validation {
  const parsed = jsonSchemaToZod(schema).safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, value, error: parsed.error.issues.map((i) => i.message).join("; ") };
}
