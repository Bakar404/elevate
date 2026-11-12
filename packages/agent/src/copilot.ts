import { CopilotClient, ToolSet, approveAll, defineTool, type CopilotSession } from "@github/copilot-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { z } from "zod";
import { responseSchema } from "./schema";

const exec = promisify(execFile);

export type ProviderKind = "copilot" | "anthropic" | "openai" | "azure";

export type ModelConfig = {
  provider: ProviderKind;
  /** Model id; empty lets the Copilot runtime choose its default. */
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** gh account whose Copilot seat pays (the one pinned in Settings); GITHUB_USER takes precedence. */
  account?: string;
};

export function modelConfigFromEnv(): ModelConfig {
  const provider = (process.env.ELEVATE_PROVIDER || "copilot") as ProviderKind;
  return {
    provider,
    model: process.env.ELEVATE_MODEL || undefined,
    baseUrl: process.env.ELEVATE_PROVIDER_BASE_URL || undefined,
    apiKey: process.env.ELEVATE_PROVIDER_API_KEY || undefined,
  };
}

/**
 * Token whose Copilot seat pays for model calls: COPILOT_GITHUB_TOKEN -> GITHUB_TOKEN ->
 * `gh auth token --user <GITHUB_USER, else the pinned account>`. Copilot usage then bills the
 * same account that owns the repos, not whichever account happens to be logged in to the
 * Copilot CLI. When an account was chosen but gh has no token for it, this throws rather than
 * billing someone else. With no account chosen it uses gh's active account, and returns
 * undefined (the logged-in Copilot CLI user) only when gh has none.
 */
export async function resolveCopilotToken(
  env: NodeJS.ProcessEnv = process.env,
  ghToken: (user?: string) => Promise<string> = ghAuthToken,
  account?: string,
): Promise<string | undefined> {
  if (env.COPILOT_GITHUB_TOKEN) return env.COPILOT_GITHUB_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const user = env.GITHUB_USER || account || undefined;
  const token = await ghToken(user).then(
    (t) => t.trim(),
    () => "",
  );
  if (token) return token;
  if (user) throw new Error(`No gh login for ${user}: run \`gh auth login\` as ${user} so Copilot usage goes to that account.`);
  return undefined;
}

async function ghAuthToken(user?: string): Promise<string> {
  const { stdout } = await exec("gh", ["auth", "token", ...(user ? ["--user", user] : [])], {
    windowsHide: true,
  });
  return stdout;
}

const CLIENT_KEY = Symbol.for("elevate.copilot.runtime");
type Runtime = { account: string; client: Promise<CopilotClient> };
type G = typeof globalThis & { [CLIENT_KEY]?: Runtime };

/**
 * One Copilot runtime per process; sessions are cheap, runtimes are not. The runtime is signed
 * in as one account (see `resolveCopilotToken`) and is replaced when that account changes.
 */
export function getCopilotClient(account?: string): Promise<CopilotClient> {
  const g = globalThis as G;
  const key = process.env.GITHUB_USER || account || "";
  const current = g[CLIENT_KEY];
  if (current?.account === key) return current.client;
  if (current) void current.client.then((c) => c.stop()).catch(() => {});
  const client = (async () => {
    const token = await resolveCopilotToken(process.env, ghAuthToken, account);
    const c = new CopilotClient({
      ...(token ? { gitHubToken: token } : {}),
      logLevel: "error",
    });
    await c.start();
    return c;
  })();
  const runtime: Runtime = { account: key, client };
  g[CLIENT_KEY] = runtime;
  client.catch(() => {
    if (g[CLIENT_KEY] === runtime) delete g[CLIENT_KEY];
  });
  return client;
}

export type ModelOption = {
  id: string;
  name: string;
  /** Who serves it (e.g. "anthropic", "openai"), when the runtime says. */
  vendor?: string;
  /** False when the account's Copilot policy has it switched off. */
  enabled: boolean;
};

type RawModel = { id: string; name?: string; provider?: unknown; policy?: { state?: string } };

/** Maps the runtime's model entry to an option. */
export function toModelOption(m: RawModel): ModelOption {
  const provider = m.provider as { name?: string; id?: string } | string | undefined;
  return {
    id: m.id,
    name: m.name || m.id,
    vendor: typeof provider === "string" ? provider : (provider?.name ?? provider?.id),
    enabled: m.policy?.state !== "disabled",
  };
}

/** Enabled before disabled, auto first; otherwise the runtime's order. */
export function sortModels(models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.id === "auto") - Number(a.id === "auto"));
}

/** Models the signed-in Copilot seat can use. */
export async function listCopilotModels(account?: string): Promise<ModelOption[]> {
  const client = await getCopilotClient(account);
  return sortModels((await client.listModels()).map((m) => toModelOption(m as RawModel)));
}

/** The GitHub login the Copilot runtime is signed in as, i.e. whose Copilot usage model calls count against. */
export async function copilotLogin(account?: string): Promise<string | undefined> {
  const status = await (await getCopilotClient(account)).getAuthStatus();
  return status.isAuthenticated ? status.login : undefined;
}

export async function stopCopilotClient() {
  const g = globalThis as G;
  const current = g[CLIENT_KEY];
  delete g[CLIENT_KEY];
  if (current) await current.client.then((c) => c.stop()).catch(() => []);
}

export type ToolSpec<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  parameters: S;
  handler: (args: z.infer<S>) => Promise<unknown> | unknown;
};

export function tool<S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

export type SessionOptions = {
  config: ModelConfig;
  system: string;
  tools?: ToolSpec[];
  /** Allow these built-in runtime tools (e.g. "web_fetch"). Defaults to none. */
  builtIns?: string[];
  streaming?: boolean;
  workingDirectory?: string;
  /** Full agent mode (file edits, shell) for swarm workers. Never used for chat. */
  fullAgent?: boolean;
};

export async function createSession(opts: SessionOptions): Promise<CopilotSession> {
  const client = await getCopilotClient(opts.config.account);
  const { config } = opts;
  const provider =
    config.provider !== "copilot" && config.baseUrl
      ? { type: config.provider, baseUrl: config.baseUrl, apiKey: config.apiKey }
      : undefined;

  const tools = (opts.tools ?? []).map((t) => {
    const params = responseSchema(t.parameters);
    return defineTool(t.name, {
      description: t.description,
      parameters: params.toJSONSchema(),
      handler: async (args: unknown) => {
        try {
          return await t.handler(params.parse(args ?? {}) as never);
        } catch (err) {
          return `Tool ${t.name} failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    } as never);
  });

  let availableTools: ToolSet | undefined;
  if (!opts.fullAgent) {
    availableTools = new ToolSet().addCustom("*");
    for (const b of opts.builtIns ?? []) availableTools.addBuiltIn(b);
  }

  return client.createSession({
    ...(config.model ? { model: config.model } : {}),
    ...(provider ? { provider: provider as never } : {}),
    streaming: opts.streaming ?? false,
    tools: tools as never,
    ...(availableTools ? { availableTools } : {}),
    systemMessage: opts.fullAgent ? { content: opts.system } : { mode: "replace", content: opts.system },
    onPermissionRequest: approveAll,
    enableSessionStore: false,
    ...(opts.workingDirectory ? { workingDirectory: opts.workingDirectory } : {}),
  } as never);
}
