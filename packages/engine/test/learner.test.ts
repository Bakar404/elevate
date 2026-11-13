import { describe, expect, it } from "vitest";
import { explain, explorationZ, featurize, fit, leanings, likeChance, normalQuantile, optimisticChance, passesOn, predict, type Example, type LearnerInput } from "../src/learner";

/**
 * From scikit-learn (test/learner_golden.py): LogisticRegression(C=1, fit_intercept=False) with sample
 * weights is the posterior mode fit() finds with prior precision 1 and prior mean 0, and the posterior sd
 * of wᵀx is sqrt(xᵀ H⁻¹ x), H = Xᵀ diag(c·p(1-p)) X + I, as in LogisticUCB (github.com/david-cortes/contextualbandits).
 */
const GOLDEN = {
  w: [-0.18578393251345715, -0.34844721872054585, 0.2974093069861499, 0.37760714616703944],
  queries: [
    { x: [1, 0, 1, 0], mean: 0.11162537447269277, sd: 0.8283144465550364 },
    { x: [1, 1, 0, 0], mean: -0.534231151234003, sd: 0.8893749117325157 },
    { x: [0.5, -1, 0.3, 2], mean: 1.0999923368937412, sd: 1.827123098980058 },
  ],
  unseen: { mean: -0.18578393251345715, sd: 1.2094858009303315 },
};

const X = [
  [1, 0, 1, 0],
  [1, 1, 0, 0],
  [1, 0, 0, 1],
  [1, 1, 1, 0],
  [1, 0, 1, 1],
  [1, 1, 0, 1],
  [1, 0.5, 0.2, 0],
  [1, -0.3, 0.8, 0.4],
  [1, 1, 1, 1],
  [1, 0, 0, 0],
];
const Y = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0] as const;
const C = [1, 1, 0.5, 1, 1, 0.5, 1, 1, 0.5, 1];
const vec = (v: number[]) => new Map(v.map((x, i) => [`f${i}`, x] as const));
const golden: Example[] = X.map((x, i) => ({ x: vec(x), y: Y[i]!, weight: C[i]! }));

const base = { repo: "demo/ledger-api", sources: ["hn"], effort: "M", risk: "low", gate1: 80, gate2: 75, relevance: 0.75, embedding: null };
const sqlIdea = (i: number): LearnerInput => ({
  ...base,
  title: `Learned query optimizer ${i}`,
  technique: `Learned SQL query optimizer, variant ${i}`,
  summary: "Uses ML to tune the Postgres query planner",
  category: "data-ml",
  cuttingEdge: true,
});
const agentIdea = (i: number): LearnerInput => ({
  ...base,
  title: `Agentic code review ${i}`,
  technique: `Multi-agent code review, variant ${i}`,
  summary: "Subagents review pull requests with tool calling",
  category: "agents",
  cuttingEdge: true,
});
const votes = (ideas: (i: number) => LearnerInput, n: number, y: 0 | 1): Example[] => Array.from({ length: n }, (_, i) => ({ x: featurize(ideas(i)), y, weight: 1 }));

describe("the learner (Bayesian logistic regression, Laplace posterior)", () => {
  it("finds the same weights and uncertainty as scikit-learn", () => {
    const model = fit(golden);
    GOLDEN.w.forEach((w, i) => expect(model.w[model.index.get(`f${i}`)!]).toBeCloseTo(w, 7));
    for (const q of GOLDEN.queries) {
      const p = predict(model, vec(q.x));
      expect(p.mean).toBeCloseTo(q.mean, 7);
      expect(p.sd).toBeCloseTo(q.sd, 7);
    }
    // A feature it never saw keeps its prior: mean 0 here, variance 1, independent of the rest.
    const unseen = predict(model, new Map([["f0", 1], ["f9", 1]]));
    expect(unseen.mean).toBeCloseTo(GOLDEN.unseen.mean, 7);
    expect(unseen.sd).toBeCloseTo(GOLDEN.unseen.sd, 7);
    expect(model).toMatchObject({ n: 10, positive: 4, negative: 4.5 });
  });

  it("doesn't depend on the order of the votes", () => {
    const a = fit(golden);
    const b = fit([...golden].reverse());
    for (const name of a.names) expect(b.w[b.index.get(name)!]).toBeCloseTo(a.w[a.index.get(name)!]!, 9);
  });

  it("before any votes, predicts from the prior: cutting-edge ideas over routine upkeep, nothing held back", () => {
    const empty = fit([]);
    const frontier = predict(empty, featurize(agentIdea(0)));
    const routine = predict(empty, featurize({ ...sqlIdea(0), cuttingEdge: false }));
    expect(empty.n).toBe(0);
    expect(likeChance(frontier)).toBeGreaterThan(0.5);
    expect(likeChance(routine)).toBeLessThan(0.5);
    expect(passesOn(empty, routine)).toBe(false);
  });

  it("ranks what you pass on lower after one vote, and holds it back only once it's sure", () => {
    const liked = votes(agentIdea, 3, 1);
    const once = fit([...liked, ...votes(sqlIdea, 1, 0)]);
    const rank = (x: LearnerInput) => optimisticChance(predict(once, featurize(x)), once.n);
    expect(rank(sqlIdea(99))).toBeLessThan(rank(agentIdea(99)));

    // Fewer than three dislikes never hold anything back.
    const twice = fit(votes(sqlIdea, 2, 0));
    expect(passesOn(twice, predict(twice, featurize(sqlIdea(99))))).toBe(false);

    // With nothing liked yet, a run of dislikes holds back more of the same but not other kinds of idea.
    const many = fit(votes(sqlIdea, 6, 0));
    expect(passesOn(many, predict(many, featurize(sqlIdea(99))))).toBe(true);
    expect(passesOn(many, predict(many, featurize(agentIdea(99))))).toBe(false);

    const mixed = fit([...liked, ...votes(sqlIdea, 8, 0)]);
    expect(passesOn(mixed, predict(mixed, featurize(sqlIdea(99))))).toBe(true);
    expect(passesOn(mixed, predict(mixed, featurize(agentIdea(99))))).toBe(false);
  });

  it("says what moved its estimate, in words", () => {
    const model = fit([...votes(agentIdea, 3, 1), ...votes(sqlIdea, 4, 0)]);
    expect(explain(model, featurize(sqlIdea(99))).away).toEqual(expect.arrayContaining(["databases"]));
    expect(explain(model, featurize(agentIdea(99))).toward).toEqual(expect.arrayContaining(["agents"]));
    const learned = leanings(model);
    expect(learned.toward).toContain("agents");
    expect(learned.away).toContain("databases");
    expect([...learned.toward, ...learned.away]).not.toContain("ideas for demo/ledger-api");
  });

  it("tags topics by meaning: Docker images aren't multimodal, a proof-of-concept isn't a proof, type inference isn't serving", () => {
    const topics = (text: string) => [...featurize({ ...sqlIdea(0), technique: text, summary: null, title: text }).keys()].filter((k) => k.startsWith("topic:"));
    expect(topics("Bump pinned Postgres images to patched minor releases")).not.toContain("topic:multimodal");
    expect(topics("Image generation models that follow a layout")).toContain("topic:multimodal");
    expect(topics("Public proof-of-concept exploit for the CVE")).not.toContain("topic:verification");
    expect(topics("Proof-driven development with Verus")).toContain("topic:verification");
    expect(topics("Faster type inference in the TypeScript compiler")).not.toContain("topic:inference");
    expect(topics("Speculative decoding cuts inference latency")).toContain("topic:inference");
  });

  it("shares what it learned between similar techniques through their embeddings", () => {
    // Two unrelated directions in a 64-dimensional embedding space, and small deterministic variations of each.
    const near = (half: 0 | 1, k: number) => Array.from({ length: 64 }, (_, i) => (i < 32 === (half === 0) ? 1 : 0) + 0.15 * Math.sin(7.3 * i + 3.1 * k));
    const idea = (half: 0 | 1, k: number): LearnerInput => ({ ...agentIdea(0), embedding: near(half, k) });
    const model = fit([0, 1, 2, 3].flatMap((k) => [{ x: featurize(idea(0, k)), y: 0 as const, weight: 1 }, { x: featurize(idea(1, k)), y: 1 as const, weight: 1 }]));
    const passedOn = predict(model, featurize(idea(0, 9)));
    const liked = predict(model, featurize(idea(1, 9)));
    expect(likeChance(passedOn)).toBeLessThan(0.4);
    expect(likeChance(liked)).toBeGreaterThan(0.6);
    expect(explain(model, featurize(idea(0, 9))).away).toContain("ideas like ones you passed on");
  });
});

describe("Bayes-UCB's quantile", () => {
  it("Φ⁻¹ is accurate to 5e-4", () => {
    const known: [number, number][] = [
      [0.5, 0],
      [0.8, 0.8416212],
      [0.975, 1.959964],
      [0.999, 3.090232],
      [0.01, -2.326348],
    ];
    for (const [q, z] of known) expect(Math.abs(normalQuantile(q) - z)).toBeLessThan(5e-4);
  });

  it("starts at the median and grows more optimistic as votes come in", () => {
    expect(Math.abs(explorationZ(0))).toBeLessThan(5e-4);
    const zs = [1, 5, 20, 100].map(explorationZ);
    for (let i = 1; i < zs.length; i++) expect(zs[i]!).toBeGreaterThan(zs[i - 1]!);
  });
});
