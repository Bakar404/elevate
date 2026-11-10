import { FakeLLM } from "@elevate/agent";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { consistentReview } from "../src/gates";

const schema = z.object({ legit: z.boolean(), score: z.number() });
const req = { task: "legitimacy", system: "", prompt: "", schema };

function llmAnswering(...answers: { legit: boolean; score: number }[]) {
  let i = 0;
  return new FakeLLM().on("legitimacy", () => answers[Math.min(i++, answers.length - 1)]);
}

describe("consistentReview", () => {
  it("accepts a consistent answer with one call", async () => {
    const llm = llmAnswering({ legit: true, score: 88 });
    expect(await consistentReview(llm, req, (r) => r.legit)).toEqual({ legit: true, score: 88, retried: false });
    expect(llm.calls).toHaveLength(1);
  });

  it("re-asks once when the verdict and score disagree", async () => {
    const llm = llmAnswering({ legit: true, score: 0 }, { legit: true, score: 90 });
    expect(await consistentReview(llm, req, (r) => r.legit)).toEqual({ legit: true, score: 90, retried: true });
    expect(llm.calls).toHaveLength(2);
  });

  it("never lets a repeated contradiction through: the score is capped below every threshold", async () => {
    const llm = llmAnswering({ legit: false, score: 95 }, { legit: false, score: 92 });
    const r = await consistentReview(llm, req, (r) => r.legit);
    expect(r.score).toBeLessThan(50);
    expect(llm.calls).toHaveLength(2);
  });
});
