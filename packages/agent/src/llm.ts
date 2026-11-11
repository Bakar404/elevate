import type { z } from "zod";
import { createSession, modelConfigFromEnv, type ModelConfig } from "./copilot";
import { responseSchema } from "./schema";
import { DEFAULT_MODEL, resolveModel, type ModelRole } from "./models";
import { defaultUsageRecorder, type UsageRecorder } from "./usage";

export type JsonRequest<T> = {
  /** Stable task name; used for logging and by the fake LLM to pick a canned answer. */
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  timeoutMs?: number;
  role?: ModelRole;
  model?: string;
};

export interface LLM {
  readonly name: string;
  json<T>(req: JsonRequest<T>): Promise<T>;
}

export class CopilotLLM implements LLM {
  readonly name = "copilot";
  constructor(
    private readonly config: ModelConfig = modelConfigFromEnv(),
    private readonly usage: UsageRecorder = defaultUsageRecorder,
  ) {}

  async json<T>(req: JsonRequest<T>): Promise<T> {
    const model = req.model?.trim() || (req.role ? resolveModel(req.role) : undefined) || this.config.model;
    const session = await createSession({ config: { ...this.config, model }, system: req.system });
    let sawUsage = false;
    let unsubscribe: (() => void) | undefined;
    try {
      if (typeof session.on === "function") {
        unsubscribe = session.on("assistant.usage", (event) => {
          sawUsage = true;
          this.usage.record({
            role: req.role,
            model: event.data.model || model || DEFAULT_MODEL,
            inputTokens: event.data.inputTokens,
            outputTokens: event.data.outputTokens,
          });
        });
      }
      return (await session.sendAndWait(req.prompt as never, responseSchema(req.schema) as never, req.timeoutMs ?? 180_000)) as T;
    } finally {
      unsubscribe?.();
      if (!sawUsage) this.usage.record({ role: req.role, model: model || DEFAULT_MODEL });
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
