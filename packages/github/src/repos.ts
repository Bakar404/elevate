import type { Octokit } from "@octokit/rest";

export type GitHubRepo = {
  githubId: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  language: string | null;
  topics: string[];
  stars: number;
  isPrivate: boolean;
  archived: boolean;
  fork: boolean;
  htmlUrl: string;
  pushedAt: string | null;
};

/** All repos the user owns or collaborates on (not org-wide). */
export async function listUserRepos(gh: Octokit): Promise<GitHubRepo[]> {
  const repos = await gh.paginate(gh.repos.listForAuthenticatedUser, {
    per_page: 100,
    affiliation: "owner,collaborator",
    sort: "pushed",
  });
  return repos.map((r) => ({
    githubId: r.id,
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    description: r.description,
    defaultBranch: r.default_branch ?? "main",
    language: r.language ?? null,
    topics: r.topics ?? [],
    stars: r.stargazers_count ?? 0,
    isPrivate: r.private,
    archived: r.archived ?? false,
    fork: r.fork,
    htmlUrl: r.html_url,
    pushedAt: r.pushed_at ?? null,
  }));
}

const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Directory.Packages.props",
  "global.json",
  "pubspec.yaml",
  "CMakeLists.txt",
  "Dockerfile",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
];

export type RepoContext = {
  readme: string;
  manifests: { path: string; content: string }[];
  tree: string[];
  languages: Record<string, number>;
  recentCommits: string[];
};

async function fileText(gh: Octokit, owner: string, repo: string, path: string, ref?: string): Promise<string | undefined> {
  try {
    const res = await gh.repos.getContent({ owner, repo, path, ref });
    const data = res.data as { content?: string; encoding?: string; size?: number };
    if (!data.content || data.encoding !== "base64") return undefined;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

/** Gather the raw material a profiler needs, keeping each piece small. */
export async function getRepoContext(gh: Octokit, fullName: string, branch: string): Promise<RepoContext> {
  const [owner, repo] = fullName.split("/") as [string, string];
  const [readmeRes, treeRes, langRes, commitsRes] = await Promise.allSettled([
    gh.repos.getReadme({ owner, repo }),
    gh.git.getTree({ owner, repo, tree_sha: branch, recursive: "true" }),
    gh.repos.listLanguages({ owner, repo }),
    gh.repos.listCommits({ owner, repo, per_page: 15 }),
  ]);

  const readme =
    readmeRes.status === "fulfilled"
      ? Buffer.from((readmeRes.value.data as { content: string }).content, "base64").toString("utf8").slice(0, 12_000)
      : "";

  const allPaths =
    treeRes.status === "fulfilled"
      ? treeRes.value.data.tree.filter((t) => t.type === "blob" && t.path).map((t) => t.path!)
      : [];
  const tree = allPaths
    .filter((p) => !/(^|\/)(node_modules|dist|build|vendor|\.git|\.next|target|__pycache__)\//.test(p))
    .filter((p) => p.split("/").length <= 4)
    .slice(0, 400);

  const manifestPaths = allPaths
    .filter((p) => MANIFESTS.some((m) => p === m || (p.endsWith(`/${m}`) && p.split("/").length <= 3)))
    .slice(0, 8);
  const manifests = (
    await Promise.all(
      manifestPaths.map(async (path) => ({ path, content: (await fileText(gh, owner, repo, path, branch))?.slice(0, 4000) ?? "" })),
    )
  ).filter((m) => m.content);

  return {
    readme,
    manifests,
    tree,
    languages: langRes.status === "fulfilled" ? langRes.value.data : {},
    recentCommits:
      commitsRes.status === "fulfilled" ? commitsRes.value.data.map((c) => c.commit.message.split("\n")[0]!.slice(0, 120)) : [],
  };
}

export async function readRepoFile(gh: Octokit, fullName: string, path: string, ref?: string) {
  const [owner, repo] = fullName.split("/") as [string, string];
  return fileText(gh, owner, repo, path, ref);
}

export async function searchCode(gh: Octokit, fullName: string, query: string) {
  const res = await gh.search.code({ q: `${query} repo:${fullName}`, per_page: 10 });
  return res.data.items.map((i) => ({ path: i.path, url: i.html_url }));
}

/** Popularity signal for the legitimacy gate: public repos mentioning the technique. */
export async function searchPublicRepos(gh: Octokit, query: string) {
  const res = await gh.search.repos({ q: query, sort: "stars", order: "desc", per_page: 5 });
  return {
    total: res.data.total_count,
    top: res.data.items.map((r) => ({
      fullName: r.full_name,
      stars: r.stargazers_count,
      url: r.html_url,
      pushedAt: r.pushed_at,
      description: r.description,
    })),
  };
}
