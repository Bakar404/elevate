/**
 * What elevate learns from your votes: a contextual bandit over recommendations.
 *
 * Each recommendation is described by sparse, named features: whether its technique is cutting-edge,
 * its category and topics, where it was found, the repo it's for, how big and risky the change is, how
 * it did at the gates, and a random projection of the technique's embedding so that similar ideas share
 * what was learned. The reward is your vote (approving or rejecting counts as a weaker one).
 *
 * The model is Bayesian logistic regression, P(like | x) = σ(wᵀx), with a Gaussian prior on w. It is
 * fit to the MAP by Newton's method (IRLS) and approximated around it by a Gaussian (Laplace), so it
 * knows how sure it is about every recommendation. That is Algorithm 3 of Chapelle & Li, "An Empirical
 * Evaluation of Thompson Sampling" (NeurIPS 2011), refit on all votes as one batch and keeping the full
 * posterior covariance rather than its diagonal (Bishop, PRML §4.5); it is the same construction as
 * LogisticUCB in github.com/david-cortes/contextualbandits. P(like) is averaged over the posterior with
 * MacKay's probit approximation (PRML §4.5.2).
 *
 * The policy is Bayes-UCB (Kaufmann, Cappé & Garivier, AISTATS 2012): open recommendations are ranked by
 * the 1 - 1/t quantile of P(like), which surfaces uncertain ideas early enough to learn about them, and
 * one is held back only when even an optimistic estimate says you'd pass on it. Treating recommendation
 * as a contextual bandit over feature vectors follows LinUCB (Li, Chu, Langford & Schapire, WWW 2010),
 * with a logistic link because a vote is binary. See "How elevate learns what you like" in the README.
 *
 * Everything here is pure. It refits from all votes whenever they change, so the result doesn't depend
 * on the order you voted in, and nothing is stored but the votes themselves.
 */

export type Features = Map<string, number>;

/** What the learner knows about one recommendation. */
export type LearnerInput = {
  title: string;
  repo: string | null;
  technique: string;
  summary: string | null;
  category: string | null;
  cuttingEdge: boolean;
  /** Source kinds the technique was found in (hn, rss, arxiv, github). */
  sources: readonly string[];
  effort?: string | null;
  risk?: string | null;
  /** Gate 1 (legitimacy) and Gate 2 (soundness) scores, 0-100. */
  gate1?: number | null;
  gate2?: number | null;
  /** How strongly the technique applies to the repo, 0-1. */
  relevance?: number | null;
  embedding?: readonly number[] | null;
};

/** One reward: y = 1 liked, 0 passed on. Explicit votes weigh 1, approvals and rejections less. */
export type Example = { x: Features; y: 0 | 1; weight: number };

export type Model = {
  names: string[];
  index: Map<string, number>;
  /** Posterior mode of the weights. */
  w: Float64Array;
  /** Cholesky factor of the posterior precision at the mode (the Laplace approximation). */
  chol: Float64Array;
  /**
   * Features with the same value in every example (the only repo voted on, say). Their weights can't be
   * told apart from how often you like anything, so they explain nothing.
   */
  constant: Set<string>;
  /** Examples the model was fit on, and their total weight by label. */
  n: number;
  positive: number;
  negative: number;
};

export type Prediction = { mean: number; sd: number };

/**
 * Prior precision λ of every weight (prior sd 1), LogisticUCB's default: a single vote nudges, a consistent
 * pattern decides. Four dislikes of one kind of idea, with nothing liked, are enough to hold the next one back.
 */
export const PRIOR_PRECISION = 1;

/** What elevate assumes before you've voted: you came for cutting-edge ideas that passed the gates. */
const PRIOR_MEAN: Record<string, number> = {
  "kind:cutting-edge": 0.75,
  "kind:routine": -1,
  "gate:legitimacy": 0.4,
  "gate:soundness": 0.4,
  relevance: 0.4,
};

export const priorMean = (feature: string) => PRIOR_MEAN[feature] ?? 0;

const TOPICS: [key: string, label: string, re: RegExp][] = [
  ["llm", "language models", /\b(llms?|language models?|gpt-?\d|claude|gemini|llama|mistral|qwen|transformers?)\b/i],
  ["agents", "agents", /\b(agents?|agentic|tool[- ]use|tool calling|function calling|multi-agent|subagents?)\b/i],
  ["retrieval", "retrieval & RAG", /\b(rag|retrieval|embeddings?|vector (search|index|store|database)s?|rerank\w*|semantic search|pgvector)\b/i],
  ["inference", "inference & serving", /\b(?<!\btype[- ])(inference|serving|quantiz\w*|distill\w*|speculative decoding|kv[- ]cache|batching)\b/i],
  ["training", "training & fine-tuning", /\b(fine-?tun\w*|training|pre-?train\w*|rlhf|dpo|grpo|lora|reinforcement learning|reward models?)\b/i],
  ["evaluation", "evals", /\b(evals?|evaluations?|benchmarks?|llm-as-a-judge|judge models?)\b/i],
  ["prompting", "prompting & context", /\b(prompts?|prompting|chain[- ]of[- ]thought|few-shot|in-context|context engineering|context windows?)\b/i],
  ["coding", "coding agents", /\b(code generation|coding agents?|copilot|codex|claude code|code review|program synthesis)\b/i],
  ["verification", "formal methods", /\b(formal(ly)? verif\w*|proofs?(?![- ]of[- ]concept)|verus|lean 4|coq|model checking|property-based)\b/i],
  ["testing", "testing", /\b(tests?|testing|fuzz\w*|mutation testing|e2e)\b/i],
  ["security", "security", /\b(security|vulnerab\w*|cves?|supply[- ]chain|sandbox\w*|prompt injection|secrets?)\b/i],
  ["data", "databases", /\b(sql|postgres\w*|mysql|sqlite|databases?|query planner)\b/i],
  ["infra", "infrastructure & CI", /\b(ci|ci\/cd|kubernetes|docker|containers?|terraform|deploy\w*|runners?|github actions)\b/i],
  ["frontend", "frontend", /\b(react|next\.?js|css|frontend|ui|browsers?|web components?)\b/i],
  ["performance", "performance", /\b(performance|faster|latency|throughput|memory usage|caching)\b/i],
  ["observability", "observability", /\b(observability|tracing|telemetry|logging|opentelemetry)\b/i],
  ["languages", "languages & compilers", /\b(rust|typescript|python|golang|compilers?|type systems?|wasm|webassembly)\b/i],
  // Not bare "images": container and Docker images are infrastructure.
  ["multimodal", "multimodal", /\b(multimodal|vision|vlms?|image (generation|models?|understanding|recognition|segmentation|editing|inputs?)|text-to-(image|video|speech)|audio|speech|video)\b/i],
];

const CATEGORY_LABEL: Record<string, string> = {
  "llm-inference": "LLM inference",
  "llm-application": "LLM apps",
  agents: "agents",
  "testing-verification": "testing & verification",
  performance: "performance",
  security: "security",
  "developer-tooling": "developer tooling",
  architecture: "architecture",
  "data-ml": "data & ML",
  "programming-languages": "programming languages",
  other: "other techniques",
};

const SOURCE_LABEL: Record<string, string> = { hn: "Hacker News finds", rss: "blog posts", arxiv: "arXiv papers", github: "GitHub projects" };

/** A feature as a person would say it, or null for ones that don't explain anything on their own. */
export function featureLabel(feature: string): string | null {
  const at = feature.indexOf(":");
  const kind = at < 0 ? feature : feature.slice(0, at);
  const value = at < 0 ? "" : feature.slice(at + 1);
  switch (kind) {
    case "kind":
      return value === "routine" ? "routine upkeep" : "cutting-edge ideas";
    case "category":
      return CATEGORY_LABEL[value] ?? value;
    case "topic":
      return TOPICS.find(([k]) => k === value)?.[1] ?? value;
    case "source":
      return SOURCE_LABEL[value] ?? value;
    case "repo":
      return `ideas for ${value}`;
    case "effort":
      return value === "S" ? "small changes" : value === "M" ? "medium-sized changes" : "large changes";
    case "risk":
      return `${value}-risk changes`;
    case "sim":
      return "ideas like ones you voted on";
    default:
      return null;
  }
}

/**
 * Features that explain a preference. Not the bias or the gate scores, which only calibrate, and not
 * "cutting-edge", which nearly every recommendation has, so it only tracks how often you like anything.
 */
const explains = (feature: string) => feature !== "kind:cutting-edge" && featureLabel(feature) !== null;

const SIM_DIM = 16;
const SIM_SCALE = 1 / 4;
const projections = new Map<number, Float64Array>();

function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed Gaussian random projection of the unit embedding: similar techniques land close together. */
function project(e: readonly number[]): number[] {
  const dim = e.length;
  let norm = 0;
  for (const v of e) norm += v * v;
  norm = Math.sqrt(norm);
  if (!dim || !norm) return [];
  let R = projections.get(dim);
  if (!R) {
    const rand = mulberry32(0x5eed);
    R = new Float64Array(SIM_DIM * dim);
    for (let i = 0; i < R.length; i++) R[i] = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    projections.set(dim, R);
  }
  const out: number[] = [];
  for (let j = 0; j < SIM_DIM; j++) {
    let s = 0;
    for (let i = 0; i < dim; i++) s += R[j * dim + i]! * e[i]!;
    out.push((s / norm) * SIM_SCALE);
  }
  return out;
}

/** Multi-hot, scaled so a group has unit norm however many members are on. */
function hot(x: Features, prefix: string, keys: string[]) {
  const v = 1 / Math.sqrt(keys.length);
  for (const k of keys) x.set(`${prefix}:${k}`, v);
}

const centered = (v: number, mid: number, span: number) => Math.max(-1.5, Math.min(1.5, (v - mid) / span));

export function featurize(r: LearnerInput): Features {
  const x: Features = new Map([["bias", 1]]);
  x.set(r.cuttingEdge ? "kind:cutting-edge" : "kind:routine", 1);
  if (r.category) x.set(`category:${r.category}`, 1);
  const text = `${r.technique}\n${r.summary ?? ""}\n${r.title}`;
  hot(x, "topic", TOPICS.filter(([, , re]) => re.test(text)).map(([k]) => k));
  hot(x, "source", [...new Set(r.sources)].sort());
  if (r.repo) x.set(`repo:${r.repo}`, 1);
  if (r.effort) x.set(`effort:${r.effort}`, 1);
  if (r.risk) x.set(`risk:${r.risk}`, 1);
  if (r.gate1 != null) x.set("gate:legitimacy", centered(r.gate1, 70, 30));
  if (r.gate2 != null) x.set("gate:soundness", centered(r.gate2, 70, 30));
  if (r.relevance != null) x.set("relevance", centered(r.relevance, 0.7, 0.3));
  if (r.embedding?.length) project(r.embedding).forEach((v, j) => x.set(`sim:${j}`, v));
  return x;
}

export const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

const logSigmoid = (z: number) => (z >= 0 ? -Math.log1p(Math.exp(-z)) : z - Math.log1p(Math.exp(z)));

/** L with LLᵀ = A, for a symmetric positive-definite A stored row-major. */
export function cholesky(A: Float64Array, d: number): Float64Array {
  const L = new Float64Array(d * d);
  for (let j = 0; j < d; j++) {
    let s = A[j * d + j]!;
    for (let k = 0; k < j; k++) s -= L[j * d + k]! ** 2;
    if (!(s > 0)) throw new Error("matrix is not positive definite");
    const ljj = Math.sqrt(s);
    L[j * d + j] = ljj;
    for (let i = j + 1; i < d; i++) {
      let t = A[i * d + j]!;
      for (let k = 0; k < j; k++) t -= L[i * d + k]! * L[j * d + k]!;
      L[i * d + j] = t / ljj;
    }
  }
  return L;
}

/** y with Ly = b. */
function forward(L: Float64Array, d: number, b: Float64Array): Float64Array {
  const y = new Float64Array(d);
  for (let i = 0; i < d; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i * d + k]! * y[k]!;
    y[i] = s / L[i * d + i]!;
  }
  return y;
}

/** x with Lᵀx = y. */
function backward(L: Float64Array, d: number, y: Float64Array): Float64Array {
  const x = new Float64Array(d);
  for (let i = d - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < d; k++) s -= L[k * d + i]! * x[k]!;
    x[i] = s / L[i * d + i]!;
  }
  return x;
}

/** x with (LLᵀ)x = b. */
export const cholSolve = (L: Float64Array, d: number, b: Float64Array) => backward(L, d, forward(L, d, b));

type Row = { idx: number[]; val: number[]; y: 0 | 1; c: number };

const dotRow = (r: Row, w: Float64Array) => r.idx.reduce((s, i, k) => s + w[i]! * r.val[k]!, 0);

/** Posterior precision Λ0 + Σ c·p(1-p)·x xᵀ at w. */
function precision(rows: Row[], w: Float64Array, d: number): Float64Array {
  const A = new Float64Array(d * d);
  for (let i = 0; i < d; i++) A[i * d + i] = PRIOR_PRECISION;
  for (const r of rows) {
    const p = sigmoid(dotRow(r, w));
    const h = r.c * p * (1 - p);
    for (let a = 0; a < r.idx.length; a++)
      for (let b = 0; b < r.idx.length; b++) {
        const k = r.idx[a]! * d + r.idx[b]!;
        A[k] = A[k]! + h * r.val[a]! * r.val[b]!;
      }
  }
  return A;
}

/** Bayesian logistic regression: the MAP by damped Newton (IRLS) and the Laplace approximation around it. */
export function fit(examples: readonly Example[]): Model {
  const names = [...new Set(examples.flatMap((e) => [...e.x.keys()]))].sort();
  const index = new Map(names.map((n, i) => [n, i] as const));
  const d = names.length;
  const m0 = Float64Array.from(names, priorMean);
  const rows: Row[] = examples
    .filter((e) => e.weight > 0)
    .map((e) => {
      const entries = [...e.x].filter(([, v]) => v !== 0);
      return { idx: entries.map(([k]) => index.get(k)!), val: entries.map(([, v]) => v), y: e.y, c: e.weight };
    });
  const objective = (w: Float64Array) => {
    let f = 0;
    for (const r of rows) {
      const z = dotRow(r, w);
      f += r.c * logSigmoid(r.y ? z : -z);
    }
    for (let i = 0; i < d; i++) f -= (PRIOR_PRECISION / 2) * (w[i]! - m0[i]!) ** 2;
    return f;
  };
  let w = Float64Array.from(m0);
  for (let iter = 0; iter < 50 && rows.length; iter++) {
    const g = new Float64Array(d);
    for (let i = 0; i < d; i++) g[i] = -PRIOR_PRECISION * (w[i]! - m0[i]!);
    for (const r of rows) {
      const resid = r.c * (r.y - sigmoid(dotRow(r, w)));
      r.idx.forEach((i, k) => (g[i] = g[i]! + resid * r.val[k]!));
    }
    const step = cholSolve(cholesky(precision(rows, w, d), d), d, g);
    const slope = step.reduce((s, v, i) => s + v * g[i]!, 0);
    if (slope < 1e-14) break;
    const f0 = objective(w);
    let t = 1;
    let next = w;
    for (; t > 1e-8; t /= 2) {
      next = w.map((v, i) => v + t * step[i]!);
      if (objective(next) >= f0 + 1e-4 * t * slope) break;
    }
    w = next;
    if (t * step.reduce((m, v) => Math.max(m, Math.abs(v)), 0) < 1e-10) break;
  }
  const support = new Uint32Array(d);
  const first = new Float64Array(d);
  const varies = new Uint8Array(d);
  for (const r of rows)
    r.idx.forEach((i, k) => {
      const v = r.val[k]!;
      if (!support[i]) first[i] = v;
      else if (first[i] !== v) varies[i] = 1;
      support[i] = support[i]! + 1;
    });
  const constant = new Set(names.filter((_, i) => rows.length > 0 && support[i] === rows.length && !varies[i]));
  return {
    names,
    index,
    w,
    chol: cholesky(precision(rows, w, d), d),
    constant,
    n: rows.length,
    positive: rows.reduce((s, r) => s + (r.y ? r.c : 0), 0),
    negative: rows.reduce((s, r) => s + (r.y ? 0 : r.c), 0),
  };
}

/**
 * The posterior of wᵀx: N(mean, sd²). Features the model never saw keep their prior, which is
 * independent of everything learned, so they add their prior mean and variance.
 */
export function predict(model: Model, x: Features): Prediction {
  const d = model.names.length;
  const v = new Float64Array(d);
  let mean = 0;
  let variance = 0;
  for (const [k, val] of x) {
    const i = model.index.get(k);
    if (i === undefined) {
      mean += priorMean(k) * val;
      variance += (val * val) / PRIOR_PRECISION;
    } else {
      v[i] = val;
      mean += model.w[i]! * val;
    }
  }
  if (d) for (const t of forward(model.chol, d, v)) variance += t * t;
  return { mean, sd: Math.sqrt(variance) };
}

/** P(like), averaged over the posterior (MacKay's probit approximation). */
export const likeChance = (p: Prediction) => sigmoid(p.mean / Math.sqrt(1 + (Math.PI * p.sd * p.sd) / 8));

/** Φ⁻¹(q), the standard normal quantile (Abramowitz & Stegun 26.2.23, error under 5e-4). */
export function normalQuantile(q: number): number {
  if (q <= 0) return -Infinity;
  if (q >= 1) return Infinity;
  if (q < 0.5) return -normalQuantile(1 - q);
  const t = Math.sqrt(-2 * Math.log(1 - q));
  return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
}

/**
 * Bayes-UCB's quantile 1 - 1/t (Kaufmann et al. 2012, with c = 0 as they recommend), as a z-score.
 * t counts rewards from 2, so the first ranking uses the median; z then grows like √(2 ln t).
 */
export const explorationZ = (n: number) => normalQuantile(1 - 1 / (n + 2));

/** The ranking score: an optimistic P(like), so ideas the model is unsure about get their chance. */
export const optimisticChance = (p: Prediction, n: number) => sigmoid(p.mean + explorationZ(n) * p.sd);

/**
 * Hold a recommendation back only when the model is 80% sure (z = 0.84, LogisticUCB's default percentile)
 * you'd like it less than 30% of the time...
 */
export const PASS_BELOW = 0.3;
const PASS_Z = 0.8416;
/** ...and only after this much negative evidence (a dislike counts 1, a rejection 0.5). */
export const MIN_NEGATIVE = 3;

export const passesOn = (model: Model, p: Prediction) => model.negative >= MIN_NEGATIVE && sigmoid(p.mean + PASS_Z * p.sd) < PASS_BELOW;

/** The label "ideas like this" features add up under, worded by which way they pull. */
const SIMILAR = "sim:";

/** Features that can explain a preference: ones with words that some votes lacked or had at another value. */
const telling = (model: Model, feature: string) => explains(feature) && !model.constant.has(feature);

/** Weight moved from the prior, added up by label (a category and a topic can both say "agents"). */
function pulls(model: Model, entries: Iterable<readonly [string, number]>) {
  const pull = new Map<string, number>();
  for (const [k, v] of entries) {
    const i = model.index.get(k);
    if (i === undefined || !telling(model, k)) continue;
    const key = k.startsWith("sim:") ? SIMILAR : featureLabel(k)!;
    pull.set(key, (pull.get(key) ?? 0) + (model.w[i]! - priorMean(k)) * v);
  }
  return pull;
}

function strongest(pull: Map<string, number>, min: number, limit: number) {
  const strong = [...pull].filter(([, c]) => Math.abs(c) >= min).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const words = (sign: 1 | -1) =>
    strong
      .filter(([, c]) => c * sign > 0)
      .slice(0, limit)
      .map(([k]) => (k === SIMILAR ? (sign > 0 ? "ideas like ones you liked" : "ideas like ones you passed on") : k));
  return { toward: words(1), away: words(-1) };
}

/** What moved this recommendation's estimate away from the prior, in words: the strongest pulls each way. */
export const explain = (model: Model, x: Features, limit = 2) => strongest(pulls(model, x), 0.05, limit);

/** What the model has learned overall: the features your votes pushed furthest from the prior. */
export function leanings(model: Model, limit = 4): { toward: string[]; away: string[] } {
  const moved = pulls(
    model,
    model.names.filter((k) => !k.startsWith("sim:")).map((k) => [k, 1] as const),
  );
  return strongest(moved, 0.1, limit);
}
