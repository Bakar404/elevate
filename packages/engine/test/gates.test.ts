import { FakeLLM } from "@elevate/agent";
import { DEFAULT_THRESHOLDS } from "@elevate/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ageNote, consistentReview, evidencePrior, YOUNG_DAYS, type EvidenceSignals } from "../src/gates";

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

describe("evidencePrior for something just published", () => {
  const floor = DEFAULT_THRESHOLDS.priorFloor;
  const preprint: EvidenceSignals = { maxCredibility: 60, distinctSources: 1, hnPoints: 0, hnStories: 0, topRepoStars: 0, evidenceLinks: 1 };

  it("doesn't hold the discussion and code it hasn't had time to get against it, and the lift fades with age", () => {
    const settled = evidencePrior(preprint);
    const fresh = evidencePrior({ ...preprint, ageDays: 1 });
    expect(settled.score).toBeLessThan(floor);
    expect(fresh.score).toBeGreaterThanOrEqual(floor);
    expect(fresh.parts).toMatchObject({ community: 0, code: 0, newness: fresh.score - settled.score });
    expect(evidencePrior({ ...preprint, ageDays: 15 }).score).toBeLessThan(fresh.score);
    expect(evidencePrior({ ...preprint, ageDays: YOUNG_DAYS })).toEqual(settled);
  });

  it("keeps a weak source under the floor however new it is", () => {
    for (const maxCredibility of [0, 20, 35]) {
      expect(evidencePrior({ maxCredibility, distinctSources: 1, hnPoints: 0, hnStories: 0, topRepoStars: 0, evidenceLinks: 0, ageDays: 0 }).score).toBeLessThan(floor);
    }
  });

  it("never goes down when a signal goes up, or when it is newer", () => {
    const grid: Record<Exclude<keyof EvidenceSignals, "ageDays">, number[]> = {
      maxCredibility: [0, 35, 60, 90],
      distinctSources: [0, 1, 2, 5],
      hnPoints: [0, 20, 400],
      hnStories: [0, 1, 12],
      topRepoStars: [0, 15, 5000],
      evidenceLinks: [0, 1, 4],
    };
    const keys = Object.keys(grid) as (keyof typeof grid)[];
    const points = keys.reduce<Omit<EvidenceSignals, "ageDays">[]>((acc, k) => acc.flatMap((p) => grid[k].map((v) => ({ ...p, [k]: v }))), [{} as EvidenceSignals]);
    const ages = [0, 3, 20, YOUNG_DAYS - 1, YOUNG_DAYS, undefined];
    for (const p of points) {
      const byAge = ages.map((ageDays) => evidencePrior({ ...p, ageDays }).score);
      for (let i = 1; i < byAge.length; i++) expect(byAge[i]).toBeLessThanOrEqual(byAge[i - 1]!);
      for (const ageDays of ages) {
        const at = evidencePrior({ ...p, ageDays }).score;
        for (const k of keys) {
          const next = grid[k][grid[k].indexOf(p[k]) + 1];
          if (next !== undefined) expect(evidencePrior({ ...p, [k]: next, ageDays }).score).toBeGreaterThanOrEqual(at);
        }
      }
    }
  });

  it("tells the reviewer how new it is, and what that means while it's new", () => {
    expect(ageNote(0)).toMatch(/^First published today\. .*absence says little yet\.$/);
    expect(ageNote(1.5)).toMatch(/^First published 1 day ago\. /);
    expect(ageNote(YOUNG_DAYS + 15)).toBe(`First published ${YOUNG_DAYS + 15} days ago.`);
  });
});
