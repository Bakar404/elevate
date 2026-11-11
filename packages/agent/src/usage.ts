import type { ModelRole } from "./models";

export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type UsageRecord = TokenUsage & {
  role: ModelRole | null;
  model: string;
};

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export class UsageRecorder {
  private readonly records = new Map<string, UsageRecord>();

  record(record: { role?: ModelRole | null; model: string; inputTokens?: number | null; outputTokens?: number | null }): void {
    const next: UsageRecord = {
      role: record.role ?? null,
      model: record.model,
      inputTokens: tokenCount(record.inputTokens),
      outputTokens: tokenCount(record.outputTokens),
    };
    const key = JSON.stringify([next.role, next.model]);
    const previous = this.records.get(key);
    if (previous) {
      next.inputTokens = previous.inputTokens === null || next.inputTokens === null ? null : previous.inputTokens + next.inputTokens;
      next.outputTokens = previous.outputTokens === null || next.outputTokens === null ? null : previous.outputTokens + next.outputTokens;
    }
    this.records.set(key, next);
  }

  snapshot(): UsageRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  reset(): void {
    this.records.clear();
  }
}

export const defaultUsageRecorder = new UsageRecorder();

/** Prices are USD per million input/output tokens, not Copilot subscription charges. */
export function estimateCostUsd(
  model: string,
  usage: { inputTokens?: number | null; outputTokens?: number | null },
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const input = tokenCount(usage.inputTokens);
  const output = tokenCount(usage.outputTokens);
  if (input === null || output === null) return null;
  try {
    const table: unknown = JSON.parse(env.ELEVATE_MODEL_PRICES_JSON || "{}");
    if (!table || typeof table !== "object" || !Object.hasOwn(table, model)) return null;
    const price = (table as Record<string, unknown>)[model];
    if (!price || typeof price !== "object") return null;
    const rates = price as Record<string, unknown>;
    const inputRate = tokenCount(rates.inputPerMTok);
    const outputRate = tokenCount(rates.outputPerMTok);
    if (inputRate === null || outputRate === null) return null;
    const cost = (input * inputRate + output * outputRate) / 1_000_000;
    return Number.isFinite(cost) ? cost : null;
  } catch {
    return null;
  }
}
