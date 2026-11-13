import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CopilotLLM, isContentFiltered } from "../src/llm";

const session = vi.hoisted(() => ({ replies: [] as string[], prompts: [] as string[], disconnected: 0 }));

vi.mock("../src/copilot", () => ({
  modelConfigFromEnv: () => ({ provider: "copilot" }),
  createSession: async () => ({
    sendAndWait: async (opts: { prompt: string }) => {
      session.prompts.push(opts.prompt);
      return { data: { content: session.replies.shift() ?? "" } };
    },
    disconnect: async () => {
      session.disconnected++;
    },
  }),
}));

const Verdict = z.object({ relevant: z.boolean(), score: z.number().max(10) });
const ask = () => new CopilotLLM({ provider: "copilot" }).json({ task: "triage", system: "s", prompt: "Classify these", schema: Verdict });

beforeEach(() => {
  session.replies = [];
  session.prompts = [];
  session.disconnected = 0;
});

describe("CopilotLLM.json", () => {
  it("asks once more when the model answers in prose, and uses the JSON it gets", async () => {
    session.replies = ["These all look relevant to me.", '{"relevant": true, "score": 14}'];
    expect(await ask()).toEqual({ relevant: true, score: 10 });
    expect(session.prompts).toEqual(["Classify these", expect.stringMatching(/only the JSON/)]);
    expect(session.disconnected).toBe(1);
  });

  it("gives up with an error that quotes what the model said", async () => {
    session.replies = ["The model is unsure about item 3.", "Still unsure."];
    await expect(ask()).rejects.toThrow('The model replied with text instead of JSON: "The model is unsure about item 3."');
    expect(session.disconnected).toBe(1);
  });

  it("reports a content-filter block as such, without asking again", async () => {
    session.replies = ["The model returned no content because the response was blocked by content filtering."];
    const err = await ask().catch((e: unknown) => e);
    expect(isContentFiltered(err)).toBe(true);
    expect(session.prompts).toHaveLength(1);
  });
});
