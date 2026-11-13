import type { z } from "zod";

type Json = Record<string, unknown>;

/**
 * Keywords that strict structured-output providers reject (Anthropic via Copilot answers
 * "For 'number' type, properties maximum, minimum are not supported"). They are moved into
 * the description so the model still sees them, and enforced locally by `repair` + zod.
 */
const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "maxItems"] as const;

export function providerSafeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(providerSafeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Json = {};
  const notes: string[] = [];
  for (const [k, v] of Object.entries(schema as Json)) {
    if ((UNSUPPORTED as readonly string[]).includes(k)) notes.push(`${k}: ${JSON.stringify(v)}`);
    else if (k === "minItems" && typeof v === "number" && v > 1) notes.push(`minItems: ${v}`);
    else out[k] = providerSafeSchema(v);
  }
  if (notes.length) out.description = [out.description, `(${notes.join(", ")})`].filter(Boolean).join(" ");
  return out;
}

/** Pull values back inside the bounds of `schema` (a JSON Schema), so small model slips don't fail validation. */
export function repair(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return value;
  const s = schema as Json;
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = s[key];
    if (Array.isArray(options)) {
      const nonNull = options.filter((o) => (o as Json)?.type !== "null");
      return nonNull.length === 1 && value !== null ? repair(value, nonNull[0]) : value;
    }
  }
  if (typeof value === "number" && (s.type === "number" || s.type === "integer")) {
    let n = s.type === "integer" ? Math.round(value) : value;
    if (typeof s.minimum === "number") n = Math.max(s.minimum, n);
    if (typeof s.maximum === "number") n = Math.min(s.maximum, n);
    return n;
  }
  if (typeof value === "string" && typeof s.maxLength === "number" && value.length > s.maxLength) {
    return value.slice(0, s.maxLength);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => repair(v, s.items));
    return typeof s.maxItems === "number" ? items.slice(0, s.maxItems) : items;
  }
  if (value && typeof value === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Json;
    return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, repair(v, props[k])]));
  }
  return value;
}

/**
 * The JSON in a model reply: the whole reply, a fenced block, or the outermost object inside prose.
 * Undefined when there is none (a model asked for JSON can still answer in prose).
 */
export function parseJsonReply(text: string): unknown {
  const t = text.trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  const candidates = [t, /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1], start >= 0 && end > start ? t.slice(start, end + 1) : undefined];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {}
  }
  return undefined;
}

/** Wrap a zod schema for `session.sendAndWait`: provider-safe JSON Schema out, repaired + validated value in. */
export function responseSchema<T>(schema: z.ZodType<T>) {
  const original = (schema as unknown as { toJSONSchema(): Json }).toJSONSchema();
  return {
    toJSONSchema: () => providerSafeSchema(original) as Json,
    parse: (value: unknown): T => schema.parse(repair(value, original)),
  };
}
