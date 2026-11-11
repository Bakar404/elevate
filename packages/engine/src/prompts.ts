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
Extract the technique precisely. Do not inflate claims beyond what the item says.`;

export const MatchSchema = z.object({
  matches: z.array(
    z.object({
      repo: z.string().describe("full_name of the repo"),
      applies: z.boolean(),
      relevance: z.number().min(0).max(1).describe("How strongly the technique applies to THIS repo"),
      title: z.string().describe("Imperative recommendation title, <= 80 chars, e.g. 'Add property-based tests to the parser'"),
      change: z.string().describe("The concrete change to make in this repo"),
      rationale: z.string().describe("Why this repo specifically benefits"),
      expectedImpact: z.string().describe("Expected, measurable outcome"),
      effort: z.enum(["S", "M", "L"]),
      risk: z.enum(["low", "medium", "high"]),
      touchpoints: z.array(z.string()).describe("Files/dirs likely to change (must exist in the profile/tree)"),
    }),
  ),
});

export const MATCH_SYSTEM = `You decide whether a newly published technique should be applied to specific existing repositories.
Be selective: most techniques do NOT apply to most repos. Only mark applies=true when there is a specific, plausible change
with a clear benefit for that repo's stack and domain. Generic advice ("add tests", "use AI") is never a match.
The prompt lists the AI products and models the user has. Never propose a change that depends on a product or model outside that list,
and never propose adopting a model version older than one they already have.`;

export const LegitimacySchema = z.object({
  legit: z.boolean().describe("Is this a real, substantiated technique (not hype, vaporware, or a misread claim)?"),
  score: z.number().min(0).max(100).describe("Confidence that the technique is legitimate, 0-100 (consistent with `legit`)"),
  verdict: z.string().describe("One sentence"),
  reasons: z.array(z.string()),
  redFlags: z.array(z.string()).describe("Hype signals, missing evidence, unreplicated claims, conflicts of interest"),
});

export const LEGITIMACY_SYSTEM = `You are a skeptical research reviewer. Decide whether a newly announced technique is legitimate:
backed by credible sources, reproducible evidence (code, benchmarks, peer review), and independent corroboration.
Penalize marketing language, single-source claims, missing code/benchmarks, and extraordinary claims without evidence.
Reward: reputable labs/venues, open code, independent replication, sustained community discussion.
Use only the evidence provided; do not assume facts not in evidence.`;

export const SoundnessSchema = z.object({
  sound: z.boolean().describe("Will this change make a real, positive difference in THIS repo, worth its cost?"),
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
and whether it will make a measurable difference. Reject changes that are cosmetic, speculative, conflict with the
existing design, or whose benefit cannot be measured. Prefer small, verifiable wins over sweeping rewrites.`;

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
