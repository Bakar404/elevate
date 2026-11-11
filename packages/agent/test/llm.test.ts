import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionEvent } from "@github/copilot-sdk";
import { CopilotLLM, type JsonRequest } from "../src/llm";
import { createSession } from "../src/copilot";
import { defaultUsageRecorder, UsageRecorder } from "../src/usage";

vi.mock("../src/copilot", () => ({
  createSession: vi.fn(),
  modelConfigFromEnv: () => ({ provider: "copilot", model: process.env.ELEVATE_MODEL || undefined }),
}));

const request: JsonRequest<{ ok: boolean }> = {
  task: "test",
  system: "Return JSON",
  prompt: "test",
  schema: z.object({ ok: z.boolean() }),
};

describe("CopilotLLM model and usage selection", () => {
  let handler: ((event: SessionEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const disconnect = vi.fn(async () => {});
  const sendAndWait = vi.fn(async () => ({ ok: true }));

  function emit(data: Record<string, unknown>) {
    handler?.({ type: "assistant.usage", data } as SessionEvent);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    handler = undefined;
    defaultUsageRecorder.reset();
    vi.stubEnv("ELEVATE_MODEL", "");
    for (const role of ["GATE1", "GATE2", "MATCHER", "SWARM"]) vi.stubEnv(`ELEVATE_MODEL_${role}`, "");
    sendAndWait.mockImplementation(async () => ({ ok: true }));
    vi.mocked(createSession).mockResolvedValue({
      on: vi.fn((_type, callback) => { handler = callback; return unsubscribe; }),
      disconnect,
      sendAndWait,
    } as never);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("selects explicit > role env > global env > default and leaves BYOK intact", async () => {
    const config = { provider: "openai" as const, model: "saved", baseUrl: "https://provider.invalid", apiKey: "test-key" };
    const llm = new CopilotLLM(config);
    vi.stubEnv("ELEVATE_MODEL_GATE1", " cheap ");
    vi.stubEnv("ELEVATE_MODEL", " global ");
    await llm.json({ ...request, role: "gate1", model: " explicit " });
    expect(createSession).toHaveBeenLastCalledWith({ config: { ...config, model: "explicit" }, system: request.system });
    await llm.json({ ...request, role: "gate1", model: "  " });
    expect(createSession).toHaveBeenLastCalledWith({ config: { ...config, model: "cheap" }, system: request.system });
    vi.stubEnv("ELEVATE_MODEL_GATE1", "");
    await llm.json({ ...request, role: "gate1" });
    expect(createSession).toHaveBeenLastCalledWith({ config: { ...config, model: "global" }, system: request.system });
    vi.stubEnv("ELEVATE_MODEL", "");
    await llm.json({ ...request, role: "gate1" });
    expect(createSession).toHaveBeenLastCalledWith({ config, system: request.system });
    await new CopilotLLM({ provider: "copilot" }).json({ ...request, role: "gate1" });
    expect(createSession).toHaveBeenLastCalledWith({ config: { provider: "copilot", model: undefined }, system: request.system });
  });

  it("preserves old config/default behavior for callers without roles", async () => {
    await new CopilotLLM({ provider: "copilot", model: "saved" }).json(request);
    expect(createSession).toHaveBeenLastCalledWith({ config: { provider: "copilot", model: "saved" }, system: request.system });
    await new CopilotLLM({ provider: "copilot" }).json(request);
    expect(createSession).toHaveBeenLastCalledWith({ config: { provider: "copilot", model: undefined }, system: request.system });
  });

  it("omits whitespace-only fallback models for roles without changing no-role callers", async () => {
    vi.stubEnv("ELEVATE_MODEL", " \t ");
    const llm = new CopilotLLM();
    await llm.json({ ...request, role: "gate1" });
    expect(createSession).toHaveBeenLastCalledWith({
      config: { provider: "copilot", model: undefined },
      system: request.system,
    });
    await llm.json(request);
    expect(createSession).toHaveBeenLastCalledWith({
      config: { provider: "copilot", model: " \t " },
      system: request.system,
    });
  });

  it("records actual SDK usage events under the reported model and unsubscribes", async () => {
    const recorder = new UsageRecorder();
    sendAndWait.mockImplementation(async () => {
      emit({ model: "actual", inputTokens: 10, outputTokens: 2 });
      emit({ model: "actual", inputTokens: 5, outputTokens: 3 });
      return { ok: true };
    });
    expect(await new CopilotLLM({ provider: "copilot" }, recorder).json({ ...request, role: "gate1" })).toEqual({ ok: true });
    expect(recorder.snapshot()).toEqual([{ role: "gate1", model: "actual", inputTokens: 15, outputTokens: 5 }]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps usage null when unsupported or absent, including failed requests", async () => {
    vi.mocked(createSession).mockResolvedValue({ disconnect, sendAndWait } as never);
    await new CopilotLLM({ provider: "copilot" }).json({ ...request, role: "matcher", model: "selected" });
    expect(defaultUsageRecorder.snapshot()).toEqual([{ role: "matcher", model: "selected", inputTokens: null, outputTokens: null }]);
    sendAndWait.mockRejectedValueOnce(new Error("failed"));
    await expect(new CopilotLLM({ provider: "copilot" }).json({ ...request, role: "gate2", model: "selected" })).rejects.toThrow("failed");
    expect(defaultUsageRecorder.snapshot()[1]).toEqual({ role: "gate2", model: "selected", inputTokens: null, outputTokens: null });
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("does not invent missing token fields in SDK usage events", async () => {
    sendAndWait.mockImplementation(async () => {
      emit({ model: "actual", inputTokens: 10 });
      return { ok: true };
    });
    await new CopilotLLM({ provider: "copilot" }).json({ ...request, role: "swarm" });
    expect(defaultUsageRecorder.snapshot()).toEqual([{ role: "swarm", model: "actual", inputTokens: 10, outputTokens: null }]);
  });
});
