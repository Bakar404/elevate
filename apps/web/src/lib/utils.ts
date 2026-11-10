import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export function ago(d: Date | string | null | undefined) {
  if (!d) return "never";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** POST/PATCH/PUT JSON and throw the server's error message on failure (for toast.promise). */
export async function send<T = unknown>(url: string, data: unknown = {}, method = "POST"): Promise<T> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

export const EXECUTORS = [
  { id: "copilot-cloud", label: "Copilot coding agent", detail: "Assigns an issue to Copilot; it opens the draft PR." },
  { id: "claude-action", label: "Claude (GitHub Action)", detail: "Mentions @claude on an issue; needs the Claude Code Action installed." },
  { id: "codex-cloud", label: "Codex cloud", detail: "Mentions @codex on an issue; needs Codex connected to the repo." },
  { id: "local", label: "Local CLI swarm", detail: "Runs copilot/claude/codex CLIs here, one per task, then pushes a draft PR." },
] as const;
