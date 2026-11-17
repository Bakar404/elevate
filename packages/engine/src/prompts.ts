import { ECOSYSTEMS } from "@elevate/sources";
import { z } from "zod";

// Schemas use .nullable() rather than .optional(): strict structured output needs every key present.

export const RepoProfileSchema = z.object({
  summary: z.string().describe("2-4 sentences: what the repo does and how it is built"),
  stack: z.array(z.string()).describe("Languages, frameworks, key libraries, infra"),
  domains: z.array(z.string()).describe("Problem domains, e.g. 'web scraping', 'LLM agents', 'embedded'"),
  keyModules: z.array(z.object({ path: z.string(), purpose: z.string() })).max(10),
  testSetup: z.string().describe("How the repo is tested, or 'none found'"),
  improvementSurfaces: z
    .array(z.string())
    .describe("Areas where new techniques could plausibly improve the repo (performance, correctness, DX, model quality...)"),
});

export const PROFILE_SYSTEM = `You are a principal engineer building a concise technical profile of a GitHub repository.
Be concrete and factual: only state what the README, manifests, file tree and commits support. Never invent modules.`;

export const TriageSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      relevant: z.boolean().describe("True only if the item introduces a concrete technique, tool, method, model or practice a software team could adopt in an existing codebase"),
      technique: z
        .object({
          name: z.string().describe("Canonical short name, e.g. 'Speculative decoding', 'Property-based testing'"),
          summary: z.string().describe("2-3 sentences: what it is and what it changes"),
          category: z.enum([
            "llm-inference",
            "llm-application",
            "agents",
            "testing-verification",
            "performance",
            "security",
            "developer-tooling",
            "architecture",
            "data-ml",
            "programming-languages",
            "other",
          ]),
          frontier: z
            .boolean()
            .describe("True for something new a team would be early to adopt (an AI or ML technique, model capability, agent pattern, research method). False for routine upkeep and established practice"),
          claimedBenefits: z.array(z.string()),
          appliesTo: z.array(z.string()).describe("Kinds of codebases/stacks that could adopt it"),
          prerequisites: z.array(z.string()),
          evidenceLinks: z.array(z.string()).describe("Paper, code, benchmark URLs mentioned"),
          requires: z
            .array(z.enum(ECOSYSTEMS))
            .describe(
              "AI vendors/products a team MUST have to adopt this: copilot (GitHub Copilot), openai (GPT models/API), codex (OpenAI Codex), anthropic (Claude models/API), claude-code, google (Gemini), xai (Grok). Use the most specific one. Empty when it works with any model or provider, or is open source",
            ),
          models: z
            .array(z.string())
            .describe("Specific model versions the item is ABOUT or depends on, as written (e.g. 'GPT-6.1', 'Claude Opus 5.5'). Not models merely compared against or used in an evaluation. Usually empty"),
        })
        .nullable(),
    }),
  ),
});

export const FRONTIER_GUIDE = `frontier=true: something new that a team would be early to adopt: an AI or ML technique, a new model capability or API, an agent or tool-use pattern, a research method, a new programming paradigm or verification approach.
frontier=false: routine upkeep and established practice: version, minor, patch or security releases, CVEs, deprecations and forced migrations, pricing or plan changes, database and infrastructure tuning tips, CI and configuration hygiene, style guides, and practices most teams already know.`;

export const TRIAGE_SYSTEM = `You triage a stream of articles, papers and posts for a tool that keeps software repos up to date with new techniques.
Mark an item relevant ONLY when it describes something concrete that an engineering team could adopt in an existing codebase
(a technique, method, library, model capability, protocol, verification approach, programming paradigm).
News, funding, opinion, hiring, politics, product launches without technical substance => not relevant.
Some items say "Found searching ... for: <repos>": they came from a search built from those repos' stacks. Judge them with those repos in mind;
a new library, tool or method that one of those repos could adopt counts as relevant, but a mere keyword hit (an unrelated project that shares a name) does not.
Timeliness matters. The prompt starts with today's date and the model versions that are current; trust those over your own memory, which is older.
An item about a model or product version that has since been replaced (an announcement, guide or tip for a previous generation) => not relevant.
An item published long ago that is only being re-shared => not relevant unless the technique itself is still new to most teams.
A bare model or product launch is not a technique; it is relevant only when it gives a team something concrete to change (a new API capability, a migration, a pricing or context change worth acting on).
For every technique, fill \`requires\` and \`models\` honestly: they decide which users see it. A general method demonstrated with one vendor's model does not require that vendor.
Set \`frontier\` just as honestly: only cutting-edge techniques become recommendations, and routine upkeep stays on the radar.
${FRONTIER_GUIDE}
Extract the technique precisely. Do not inflate claims beyond what the item says.`;

export const ClassifySchema = z.object({
  results: z.array(z.object({ index: z.number().int(), frontier: z.boolean() })),
});

export const CLASSIFY_SYSTEM = `You sort techniques for a tool that recommends cutting-edge changes to software repositories.
${FRONTIER_GUIDE}
Judge each technique on its own and answer for every index.`;

export const MatchSchema = z.object({
  matches: z.array(
    z.object({
      repo: z.string().describe("full_name of the repo"),
      applies: z.boolean(),
      relevance: z.number().min(0).max(1).describe("How strongly the technique applies to THIS repo"),
      title: z.string().describe("Imperative recommendation title, <= 80 chars, e.g. 'Add property-based tests to the parser'"),
      change: z.string().describe("The concrete change to make in this repo"),
      rationale: z.string().describe("Why this repo specifically benefits"),
      expectedImpact: z.string().describe("Expected outcome, and the before/after check on this repo that would show it"),
      effort: z.enum(["S", "M", "L"]),
      risk: z.enum(["low", "medium", "high"]),
      touchpoints: z.array(z.string()).describe("Files/dirs likely to change (must exist in the profile/tree)"),
    }),
  ),
});

export const MATCH_SYSTEM = `You decide whether a newly published technique should be applied to specific existing repositories.
Be selective: most techniques do NOT apply to most repos. Only mark applies=true when there is a specific, plausible change
with a clear benefit for that repo's stack and domain. Generic advice ("add tests", "use AI") is never a match, and neither is
something the profile shows the repo already does.
The technique is new, so the change can be a small trial rather than full adoption: behind a flag, in one module, or as an eval
that compares against what the repo does today. Keep the change to what the trial needs.
In expectedImpact, say what would be measured and how: a check that runs on this repo before and after the change (its tests,
evals or benchmarks, or a replay of data it already records) and is sensitive enough to show the effect. A live A/B over real
usage is not a check: it takes too many runs to show anything.
The prompt lists the AI products and models the user has. Never propose a change that depends on a product or model outside that list,
and never propose adopting a model version older than one they already have.`;

export const LegitimacySchema = z.object({
  legit: z.boolean().describe("Is this a real, specific technique backed by evidence (not hype, vaporware, or a misread claim)?"),
  score: z.number().min(0).max(100).describe("Confidence that the technique is legitimate, 0-100 (consistent with `legit`)"),
  verdict: z.string().describe("One sentence"),
  reasons: z.array(z.string()),
  redFlags: z.array(z.string()).describe("Hype signals, claims the sources don't support, missing method or results, conflicts of interest"),
});

export const LEGITIMACY_SYSTEM = `You are a careful research reviewer. Techniques reach you soon after they are published, often as a single
preprint, lab post or release note. Decide whether this one is legitimate: a real, specific method whose sources say how it works
and back it with evidence, such as reported results or benchmarks, released code, or a credible lab, venue or vendor.
Judge what the sources say, not how much attention they have had yet. The independent evidence prior already weighs corroboration,
discussion and public code, and new work hasn't had time to gather them, so don't lower your score because they are missing.
Set legit=false for hype: marketing without technical content, vaporware ("coming soon"), claims the sources don't support,
extraordinary claims without evidence, or a misreading of what the source says.
Score: 85+ established and replicated; 70-84 a specific method with reported results from a credible source, even if new;
50-69 plausible but thin (vague method, no results, weak source); below 50 not legitimate.
Use only the evidence provided, including the source excerpts; do not assume facts not in evidence.`;

export const SoundnessSchema = z.object({
  sound: z.boolean().describe("Is this change (or trial) technically sound for THIS repo, with a real chance of a positive difference worth its cost?"),
  score: z.number().min(0).max(100).describe("Confidence the change is sound and worth it for THIS repo, 0-100 (consistent with `sound`)"),
  verdict: z.string(),
  reasons: z.array(z.string()),
  risks: z.array(z.string()),
  expectedImpact: z.string().describe("Specific, measurable outcome"),
  measurement: z.string().describe("How to prove the improvement: benchmark, test, metric, before/after"),
  measurable: z
    .boolean()
    .describe("True only if `measurement` names a concrete check that can be run on this repo before and after the change"),
  risk: z.enum(["low", "medium", "high"]).describe("Risk of regressions or disruption in THIS repo"),
  effort: z.enum(["S", "M", "L"]),
});

export const SOUNDNESS_SYSTEM = `You are a pragmatic staff engineer reviewing a proposed change to a codebase.
Judge whether the change is technically sound for THIS code (stack, architecture, constraints visible in the files)
and whether its effect can be measured. The technique is new, so nobody can be sure of the outcome in advance: a small,
reversible trial (behind a flag, in one module, or as an eval) with a concrete before/after check on this repo, such as a
benchmark, eval, test, token or latency count, is sound when it fits the code. Score how well the experiment is designed
and what it costs, not certainty about its result.
Reject changes that are cosmetic, already done, conflict with the existing design or the user's tools, cannot be measured,
or need a sweeping rewrite.
Report the risk of regressions in \`risk\`, not in the score: the bar a change must clear already rises with its risk.
Score: 80+ a clear win for this repo with a solid check; 65-79 a sound trial worth running (it fits the code, is cheap to try
and to undo, and has a concrete before/after check); 50-64 plausible but weak (little benefit here, a weak check, or a cost
out of proportion to the gain); below 50 unsound.`;

export const PlanSchema = z.object({
  summary: z.string(),
  acceptanceCriteria: z.array(z.string()),
  subtasks: z
    .array(
      z.object({
        key: z.string().describe("short-kebab-id"),
        title: z.string(),
        instructions: z.string().describe("Self-contained instructions for one coding agent"),
        files: z.array(z.string()),
        dependsOn: z.array(z.string()),
      }),
    )
    .min(1)
    .max(6),
  verification: z.string().describe("Commands/checks that prove the change works and delivers the impact"),
});

export const PLAN_SYSTEM = `You are a tech lead splitting an approved improvement into a few independent coding tasks for parallel agents.
Tasks should touch disjoint files where possible. Each task's instructions must be self-contained.
Keep the change minimal and reviewable; include tests that demonstrate the improvement.`;

export const ReviewSchema = z.object({
  approve: z.boolean(),
  summary: z.string(),
  issues: z.array(z.string()),
});

export const REVIEW_SYSTEM = `You review a diff produced by coding agents against the approved plan.
Approve only if it implements the plan, is minimal, has no obvious bugs or security issues, and includes verification.`;

export const CHAT_SYSTEM = `You are Elevate, an agent that keeps a developer's GitHub repositories current with fast-moving techniques.
You can see the user's repos (profiles, files, code search), the knowledge radar (new techniques from Hacker News, AI labs, arXiv),
and recommendations that passed two gates: (1) the technique is legitimate, (2) the change is sound and measurable for that repo.
Use tools to ground every claim. Cite technique sources and repo files. Be concise and specific.
Only suggest AI models and products the user has access to (ask \`list_access\` if unsure); never recommend a model version that has been superseded.
You never write to repositories directly: propose recommendations, and the user approves swarms in the inbox.`;
