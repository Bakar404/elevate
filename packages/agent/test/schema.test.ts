import { describe, expect, it } from "vitest";
import { z } from "zod";
import { responseSchema } from "../src/schema";

const review = z.object({
  score: z.number().min(0).max(100),
  risk: z.enum(["low", "medium", "high"]),
  tasks: z.array(z.object({ title: z.string().max(10), index: z.number().int() })).min(1).max(2),
  note: z.string().optional(),
});

describe("responseSchema", () => {
  it("sends no keywords strict providers reject, but keeps them visible to the model", () => {
    const sent = JSON.stringify(responseSchema(review).toJSONSchema());
    for (const k of ['"minimum"', '"maximum"', '"maxLength"', '"maxItems"']) expect(sent).not.toContain(k);
    expect(sent).toContain("maximum: 100");
    expect(sent).toContain('"enum"');
  });

  it("repairs small slips before validating", () => {
    const parsed = responseSchema(review).parse({
      score: 140,
      risk: "low",
      tasks: [{ title: "a very long title", index: 1.6 }, { title: "b", index: 2 }, { title: "c", index: 3 }],
    });
    expect(parsed).toEqual({ score: 100, risk: "low", tasks: [{ title: "a very lon", index: 2 }, { title: "b", index: 2 }] });
  });

  it("still rejects answers that are wrong rather than out of range", () => {
    expect(() => responseSchema(review).parse({ score: 50, risk: "extreme", tasks: [] })).toThrow();
  });
});
