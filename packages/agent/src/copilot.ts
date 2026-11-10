import { CopilotClient, ToolSet, approveAll, defineTool, type CopilotSession } from "@github/copilot-sdk";
import type { z } from "zod";
import { responseSchema } from "./schema";

export type ProviderKind = "copilot" | "anthropic" | "openai" | "azure";

export type ModelConfig = {
  provider: ProviderKind;
  /** Model id; empty lets the Copilot runtime choose its default. */
  model?: string;
  baseUrl?: string;
  apiKey?: string;
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

const CLIENT_KEY = Symbol.for("elevate.copilot");
type G = typeof globalThis & { [CLIENT_KEY]?: Promise<CopilotClient> };

/** One Copilot runtime per process; sessions are cheap, runtimes are not. */
export function getCopilotClient(): Promise<CopilotClient> {
  const g = globalThis as G;
  if (!g[CLIENT_KEY]) {
    g[CLIENT_KEY] = (async () => {
      const token = process.env.COPILOT_GITHUB_TOKEN;
      const client = new CopilotClient({
        ...(token ? { gitHubToken: token } : {}),
        logLevel: "error",
      });
      await client.start();
      return client;
    })().catch((err) => {
      delete g[CLIENT_KEY];
      throw err;
    });
  }
  return g[CLIENT_KEY];
}

export async function stopCopilotClient() {
  const g = globalThis as G;
  const pending = g[CLIENT_KEY];
  delete g[CLIENT_KEY];
  if (pending) await (await pending).stop().catch(() => []);
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
  const client = await getCopilotClient();
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
