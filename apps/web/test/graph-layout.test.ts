import type { ActivityGraph } from "@elevate/engine";
import { describe, expect, it } from "vitest";
import { inside, labelBox, layout, overlaps, techLabel } from "../src/lib/graph-layout";

describe("live map labels", () => {
  it("drop asides and cut at a word boundary", () => {
    expect(techLabel("SatisFix (mitigating spurious failures)", 26)).toBe("SatisFix");
    expect(techLabel("TokenEconomizer (experience-learned pre", 26)).toBe("TokenEconomizer");
    expect(techLabel("Presupposition-checked question answering", 26)).toBe("Presupposition-checked…");
    expect(techLabel("Contain/Conform/Compare/Correct loop", 26)).toBe("Contain/Conform/Compare…");
    expect(techLabel("Supercalifragilisticexpialidocious", 15)).toBe("Supercalifragi…");
  });

  it("put a repo's name on the side away from the hub when nothing's in the way", () => {
    const repos = ["elevate", "ecorp", "cairn", "TokenMasterX"].map((name, i) => ({ id: `r${i}`, name, fullName: `me/${name}`, language: null, state: "review" as const, open: 2, prs: 0 }));
    const g = { repos, techniques: [], links: [], hidden: 0, hiddenTechniques: 0 } as unknown as ActivityGraph;
    const { repoPos, repoLabels } = layout(g);
    // r0 sits at the top of the ring and r2 at the bottom.
    expect(repoLabels.get("r0")!.y).toBeLessThan(repoPos.get("r0")!.y);
    expect(repoLabels.get("r2")!.y).toBeGreaterThan(repoPos.get("r2")!.y);
  });

  it("stay apart and off the nodes when the map is crowded", () => {
    const names = ["TokenMasterX", "agent-evals-harness", "awesome-copilot-skills", "elevate", "ecorp", "cairn"];
    const repos = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      name: names[i % names.length]!,
      fullName: `me/r${i}`,
      language: null,
      state: "review" as const,
      open: 3,
      prs: 0,
    }));
    const techniques = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, name: `Experience-learned session prefix number ${i}`, category: null }));
    // Every technique wants the same two repos, the worst case for the layout.
    const links = techniques.flatMap((t, i) => [
      { id: `${t.id}a`, repoId: "r0", techniqueId: t.id, status: "open", score: 70 + i },
      { id: `${t.id}b`, repoId: "r1", techniqueId: t.id, status: "open", score: 60 + i },
    ]);
    const g = { repos, techniques, links, hidden: 3, hiddenTechniques: 20 } as unknown as ActivityGraph;
    const { repoPos, techPos, repoLabels, techLabels } = layout(g);

    const nodes = [...repoPos.values(), ...techPos.values()].map((p) => ({ x0: p.x - 6, y0: p.y - 6, x1: p.x + 6, y1: p.y + 6 }));
    const labels = [
      ...repos.map((r) => labelBox(repoLabels.get(r.id)!, "repo", ` ${r.open}`.length)),
      ...[...techLabels.values()].flatMap((l) => (l ? [labelBox(l, "tech")] : [])),
    ];
    expect(labels.length).toBeGreaterThanOrEqual(12 + 6);
    for (const [i, b] of labels.entries()) {
      expect(inside(b)).toBe(true);
      for (const other of [...labels.slice(i + 1), ...nodes]) expect(overlaps(b, other, 0)).toBe(false);
    }
  });
});
