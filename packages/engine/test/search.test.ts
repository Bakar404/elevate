import { describe, expect, it } from "vitest";
import { repoScore, searchRepos, type SearchableRepo } from "../src/search";

const repo = (fullName: string, o: Partial<SearchableRepo> & { stack?: string[]; domains?: string[]; summary?: string } = {}): SearchableRepo => ({
  fullName,
  description: o.description ?? null,
  language: o.language ?? null,
  topics: o.topics ?? [],
  profile:
    o.stack || o.domains || o.summary
      ? { summary: o.summary ?? "", stack: o.stack ?? [], domains: o.domains ?? [], keyModules: [], improvementSurfaces: [] }
      : null,
});

const built = repo("me/ledger", { stack: ["TypeScript", "Postgres"], domains: ["fintech"] });
const mentions = repo("me/notes", { description: "Notes app; might move to postgres someday" });
const other = repo("me/game", { language: "Rust", topics: ["gamedev"] });

describe("searchRepos", () => {
  it("an empty query returns everything in the original order", () => {
    const rows = [other, built, mentions];
    expect(searchRepos(rows, "  ")).toEqual(rows);
  });

  it("ranks a repo built on the term above one that only mentions it, and drops non-matches", () => {
    expect(searchRepos([mentions, other, built], "postgres").map((r) => r.fullName)).toEqual(["me/ledger", "me/notes"]);
  });

  it("every word has to match somewhere (AND), across different fields", () => {
    expect(searchRepos([built, mentions, other], "fintech typescript").map((r) => r.fullName)).toEqual(["me/ledger"]);
    expect(searchRepos([built, mentions, other], "fintech rust")).toEqual([]);
  });

  it("is case- and accent-insensitive and tolerates prefixes", () => {
    expect(repoScore(built, "POSTGRÉS")).toBeGreaterThan(0);
    expect(repoScore(built, "postg")).toBeGreaterThan(0);
    expect(repoScore(built, "postgres")).toBeGreaterThan(repoScore(built, "postg"));
  });

  it("does not treat regex characters in the query specially", () => {
    expect(() => searchRepos([built, mentions], "c++ (")).not.toThrow();
    expect(searchRepos([repo("me/engine", { stack: ["C++"] })], "c++")).toHaveLength(1);
  });

  it("keeps the input order between equal scores", () => {
    const a = repo("me/a", { language: "Rust" });
    const b = repo("me/b", { language: "Rust" });
    expect(searchRepos([b, a], "rust").map((r) => r.fullName)).toEqual(["me/b", "me/a"]);
  });
});
