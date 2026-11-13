import type { z } from "zod";
import { createSession, modelConfigFromEnv, type ModelConfig } from "./copilot";
import { parseJsonReply, responseSchema } from "./schema";

export type JsonRequest<T> = {
  /** Stable task name; used for logging and by the fake LLM to pick a canned answer. */
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  timeoutMs?: number;
};

export interface LLM {
  readonly name: string;
  json<T>(req: JsonRequest<T>): Promise<T>;
}

/** Sent once when a reply has no JSON in it. */
const JSON_ONLY = "That reply wasn't JSON. Answer again with only the JSON object the schema describes.";

/**
 * What the Copilot runtime puts in place of the model's answer when there is none, e.g. "The model returned
 * no content because the response was blocked by content filtering." Asking again in the same conversation
 * gets the same notice.
 */
const NO_CONTENT = /^The model returned no content because\b/;

/** The provider's content filter blocked the answer. Usually one input in the prompt trips it. */
export class ContentFiltered extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentFiltered";
  }
}

/** Checked by name, so it holds when a bundler gives two chunks their own copy of this module. */
export const isContentFiltered = (err: unknown): err is ContentFiltered => err instanceof Error && err.name === "ContentFiltered";

const clip = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export class CopilotLLM implements LLM {
  readonly name = "copilot";
  constructor(private readonly config: ModelConfig = modelConfigFromEnv()) {}

  async json<T>(req: JsonRequest<T>): Promise<T> {
    const schema = responseSchema(req.schema);
    const session = await createSession({ config: this.config, system: req.system });
    const ask = async (prompt: string) => {
      const reply = await session.sendAndWait({ prompt, responseSchema: schema.toJSONSchema() }, req.timeoutMs ?? 180_000);
      return reply?.data.content.trim() ?? "";
    };
    try {
      const first = await ask(req.prompt);
      if (NO_CONTENT.test(first)) throw /content filter/i.test(first) ? new ContentFiltered(first) : new Error(first);
      // Models occasionally answer a structured request in prose; ask once more before giving up.
      const value = parseJsonReply(first) ?? parseJsonReply(await ask(JSON_ONLY));
      if (value === undefined) throw new Error(`The model replied with text instead of JSON: "${clip(first)}"`);
      return schema.parse(value);
    } finally {
      await session.disconnect().catch(() => {});
    }
  }
}

type FakeHandler = (req: JsonRequest<unknown>) => unknown;

/** Deterministic LLM for tests and offline demos. Answers are validated against the schema. */
export class FakeLLM implements LLM {
  readonly name = "fake";
  readonly calls: JsonRequest<unknown>[] = [];
  private handlers = new Map<string, FakeHandler>();

  on(task: string, handler: FakeHandler): this {
    this.handlers.set(task, handler);
    return this;
  }

  async json<T>(req: JsonRequest<T>): Promise<T> {
    this.calls.push(req as JsonRequest<unknown>);
    const handler = this.handlers.get(req.task);
    if (!handler) throw new Error(`FakeLLM has no handler for task "${req.task}"`);
    return req.schema.parse(await handler(req as JsonRequest<unknown>));
  }
}
