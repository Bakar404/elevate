import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ProofStep = { id: string; name: string; ok: boolean; detail: string; seconds: number };
export type ProofRequirement = { id: string; text: string; proved: string; mutant: string; checked: string };
export type ProofReceipt = { pass: boolean; at: string; gitHead: string; steps: ProofStep[]; requirements: ProofRequirement[]; versions: Record<string, string> };

function repoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "proof", "RECEIPT.md"))) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

/** The PDD receipt for the policy kernel: what was proved, mutation-checked and differentially tested. */
export function readReceipt(): ProofReceipt | undefined {
  const root = repoRoot();
  if (!root) return undefined;
  const runPath = path.join(root, "proof", "results", "run.json");
  if (!existsSync(runPath)) return undefined;
  const run = JSON.parse(readFileSync(runPath, "utf8")) as Omit<ProofReceipt, "requirements">;
  const md = readFileSync(path.join(root, "proof", "RECEIPT.md"), "utf8");
  const requirements = md
    .split(/\r?\n/)
    // Requirement ids are one letter and a number (L1, M3); mutants (MM3) and trust-base rows (TB1) have two letters.
    .filter((l) => /^\| [A-Z]\d+ \|/.test(l))
    .map((l) => {
      const [id, text, proved, mutant, checked] = l.split("|").slice(1, 6).map((c) => c.trim());
      return { id: id!, text: text!, proved: proved!, mutant: mutant!, checked: checked! };
    });
  return { ...run, requirements };
}
