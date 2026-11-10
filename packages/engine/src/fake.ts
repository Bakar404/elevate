import { FakeLLM, type JsonRequest } from "@elevate/agent";

const TECH_WORDS =
  /proof|verif|formal|test|fuzz|agent|llm|inference|decod|compil|rust|wasm|performance|benchmark|weight|retriev|rag|type|security|cache|quantiz|distill|embedding|vector|parser|kernel|spec/i;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9+-]{3,}/g) ?? []);
const num = (s: string, re: RegExp, fallback = 0) => Number(s.match(re)?.[1] ?? fallback);

/**
 * A deterministic stand-in for the model, used by tests, the e2e suite and offline demos
 * (ELEVATE_DEMO=1). It reads the same prompts the real model gets and answers with simple,
 * explainable heuristics, so the whole pipeline runs without network or credentials.
 */
export function demoLLM(): FakeLLM {
  return new FakeLLM()
    .on("profile", (req) => {
      const p = req.prompt;
      const lang = p.match(/Primary language: ([^;\n]+)/)?.[1]?.trim() ?? "unknown";
      const topics = (p.match(/topics: ([^\n]+)/)?.[1] ?? "").split(",").map((t) => t.trim()).filter((t) => t && t !== "none");
      const tree = (p.match(/File tree \(truncated\):\n([\s\S]*?)\n\n/)?.[1] ?? "").split("\n").filter(Boolean);
      return {
        summary: `${p.match(/Repository: (.+)/)?.[1] ?? "Repo"}: ${p.match(/Description: (.+)/)?.[1] ?? ""}`.trim(),
        stack: [lang],
        domains: topics.length ? topics : ["software"],
        keyModules: tree.slice(0, 5).map((path) => ({ path, purpose: "source" })),
        testSetup: tree.some((f) => /test|spec/i.test(f)) ? "Has tests" : "none found",
        improvementSurfaces: ["testing and verification", "performance"],
      };
    })
    .on("triage", (req) => {
      const entries = [...req.prompt.matchAll(/\[(\d+)\] \(([^)]+)\) (.+)\nURL: (\S+)\n?([^\[]*)/g)];
      return {
        results: entries.map(([, i, , title, url, body]) => {
          const t = title!.trim();
          const relevant = TECH_WORDS.test(t);
          const name = t.split(/[:\u2013\u2014(]/)[0]!.trim().slice(0, 60);
          return {
            index: Number(i),
            relevant,
            technique: relevant
              ? {
                  name,
                  summary: (body ?? "").trim().slice(0, 240) || t,
                  category: /verif|proof|test|fuzz|formal|\bspec\b/i.test(t) ? "testing-verification" : /infer|decod|quantiz/i.test(t) ? "llm-inference" : "developer-tooling",
                  claimedBenefits: ["Fewer defects", "Faster iteration"],
                  appliesTo: [...words(t)].slice(0, 5),
                  prerequisites: [],
                  evidenceLinks: [url!],
                }
              : null,
          };
        }),
      };
    })
    .on("match", (req) => {
      const tech = words(req.prompt.split("Repositories:")[0] ?? "");
      const sections = req.prompt.split("\n### ").slice(1);
      return {
        matches: sections.map((s) => {
          const [repo, ...rest] = s.split("\n");
          const overlap = [...words(rest.join("\n"))].filter((w) => tech.has(w)).length;
          const relevance = Math.min(0.95, 0.4 + overlap * 0.08);
          return {
            repo: repo!.trim(),
            applies: overlap >= 2,
            relevance,
            title: `Apply ${req.prompt.match(/Technique: ([^(\n]+)/)?.[1]?.trim() ?? "technique"} to ${repo!.split("/")[1]}`.slice(0, 80),
            change: "Introduce the technique in the module it fits best and cover it with a before/after check.",
            rationale: `The repo's profile shares ${overlap} key concepts with the technique.`,
            expectedImpact: "Fewer regressions caught late; measurable via the test suite.",
            effort: "M",
            risk: "low",
            touchpoints: ["README.md"],
          };
        }),
      };
    })
    .on("legitimacy", (req) => {
      const prior = num(req.prompt, /Independent evidence prior: (\d+)/);
      return {
        legit: prior >= 25,
        score: Math.min(95, prior + 25),
        verdict: prior >= 25 ? "Credible source with supporting evidence." : "Thin, single-source evidence.",
        reasons: [`Evidence prior ${prior}/100`],
        redFlags: prior < 25 ? ["No independent corroboration"] : [],
      };
    })
    .on("soundness", (req) => {
      const legit = num(req.prompt, /Technique legitimacy: (\d+)/);
      const tech = words(req.prompt.match(/Technique: (.+)/)?.[1] ?? "");
      const surfaces = words([req.prompt.match(/Domains: (.+)/)?.[1], req.prompt.match(/Improvement surfaces: (.+)/)?.[1]].join(" "));
      const shared = [...tech].filter((w) => surfaces.has(w));
      const sound = shared.length > 0;
      return {
        sound,
        score: sound ? Math.min(90, 40 + Math.round(legit / 2)) : 30,
        verdict: sound ? "Fits the repo's stack; small, verifiable change." : "The technique doesn't touch anything this repo cares about.",
        reasons: sound ? [`Addresses the repo's ${shared.slice(0, 3).join(", ")}`] : ["No overlap with the repo's domains or improvement surfaces"],
        risks: ["Adds a dev dependency"],
        expectedImpact: sound ? "Catches a class of bugs the current tests miss." : "None expected for this codebase.",
        measurement: "Run the test suite before and after; count newly caught failures.",
        measurable: true,
        risk: "low",
        effort: "M",
      };
    })
    .on("plan", (req: JsonRequest<unknown>) => ({
      summary: `Implement: ${req.prompt.match(/Recommendation: (.+)/)?.[1] ?? "the change"}`,
      acceptanceCriteria: ["The change is covered by tests", "Existing tests still pass"],
      subtasks: [
        { key: "implement", title: "Implement the change", instructions: "Make the change in the touchpoints.", files: ["README.md"], dependsOn: [] },
        { key: "tests", title: "Add before/after checks", instructions: "Add tests that demonstrate the improvement.", files: [], dependsOn: ["implement"] },
      ],
      verification: "Run the test suite.",
    }))
    .on("review", () => ({ approve: true, summary: "Looks good.", issues: [] }));
}
