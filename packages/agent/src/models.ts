export const MODEL_ROLES = ["gate1", "gate2", "matcher", "swarm"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** Empty means omit the model and retain the Copilot runtime's default. */
export const DEFAULT_MODEL = "";

export function resolveModel(role: ModelRole, env: NodeJS.ProcessEnv = process.env): string {
  return env[`ELEVATE_MODEL_${role.toUpperCase()}`]?.trim() || env.ELEVATE_MODEL?.trim() || DEFAULT_MODEL;
}

export function resolveAllModels(env: NodeJS.ProcessEnv = process.env): Record<ModelRole, string> {
  return Object.fromEntries(MODEL_ROLES.map((role) => [role, resolveModel(role, env)])) as Record<ModelRole, string>;
}
