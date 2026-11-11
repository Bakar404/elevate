"use client";

import { KeyRound, Plug } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EXECUTORS, cn, send } from "@/lib/utils";
import { ModelPicker, useModels } from "./model-picker";
import { Badge, Button, Card } from "./ui";

type Settings = {
  demo: boolean;
  model: { provider: string; model: string; baseUrl: string; hasApiKey: boolean };
  models: { pipeline: string; chat: string; codingAgent: string };
  github: { connected: boolean; login: string | null; source: string; error?: string };
  executor: string;
  thresholds: { legitimacy: number; priorFloor: number; soundness: number };
  budget: { maxTasks: number; maxMinutes: number; maxAgentTurns: number };
};

const PROVIDERS = [
  { id: "copilot", label: "GitHub Copilot", hint: "Uses your Copilot subscription through the Copilot SDK." },
  { id: "anthropic", label: "Anthropic", hint: "Claude models with your own API key." },
  { id: "openai", label: "OpenAI", hint: "GPT models with your own API key." },
  { id: "azure", label: "Azure OpenAI", hint: "Your Azure deployment: base URL and key." },
];

const input = "h-9 w-full rounded-lg border border-line-strong bg-bg/60 px-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-sky/50";

export function SettingsForm() {
  const [s, setS] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [ghToken, setGhToken] = useState("");
  const { data: catalog, refresh: refreshModels } = useModels();

  const load = () =>
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setS);
  useEffect(() => {
    load();
  }, []);

  if (!s) return <Card className="mt-8 h-96 animate-pulse" />;

  const save = (data: unknown, msg: string) => {
    const done = send("/api/settings", data, "PUT").then(load);
    toast.promise(done, { loading: "Saving…", success: msg, error: (e: Error) => e.message });
    return done;
  };
  const num = (v: string) => Math.max(0, Number(v) || 0);
  // The live list belongs to the saved provider; after switching provider, ids are typed until saved.
  const listed = catalog && catalog.provider === s.model.provider ? catalog.models : [];
  const nameOf = (id: string) => listed.find((m) => m.id === id)?.name ?? id;
  const providerDefault = s.model.provider === "copilot" ? "Copilot default" : "Provider default";

  return (
    <div className="mt-8 grid gap-6">
      <Card className="p-6">
        <h2 className="font-medium">Model</h2>
        <p className="mt-1 text-sm text-muted">
          Every agent (chat, gates, swarm planner) runs on the Copilot SDK. Other providers plug in with your own key. Pick a model for background work and a
          default for chat; each conversation can switch on its own.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-4" role="radiogroup">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={s.model.provider === p.id}
              onClick={() => setS({ ...s, model: { ...s.model, provider: p.id } })}
              className={cn(
                "rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color] duration-150",
                s.model.provider === p.id ? "border-sky/50 bg-sky/10" : "border-line hover:border-line-strong",
              )}
            >
              <div className="text-sm font-medium">{p.label}</div>
              <div className="mt-0.5 text-xs text-muted">{p.hint}</div>
            </button>
          ))}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5 text-xs text-faint" data-testid="pipeline-model">
            <span>Background agents: triage, gates, swarm planner</span>
            <ModelPicker
              label="Background model"
              value={s.model.model}
              models={listed}
              defaultLabel={providerDefault}
              onChange={(id) => setS({ ...s, model: { ...s.model, model: id }, models: { ...s.models, pipeline: id } })}
            />
          </div>
          <div className="grid gap-1.5 text-xs text-faint" data-testid="chat-model">
            <span>Chat default</span>
            <ModelPicker
              label="Chat model"
              value={s.models.chat}
              models={listed}
              defaultLabel={s.model.model ? `Same as background (${nameOf(s.model.model)})` : `Same as background (${providerDefault})`}
              onChange={(id) => setS({ ...s, models: { ...s.models, chat: id } })}
            />
          </div>
          <div className="grid gap-1.5 text-xs text-faint" data-testid="coding-agent-model">
            <span>Swarms: Copilot coding agent</span>
            <ModelPicker
              label="Coding agent model"
              value={s.models.codingAgent}
              models={listed}
              defaultLabel="Auto (GitHub picks)"
              onChange={(id) => setS({ ...s, models: { ...s.models, codingAgent: id } })}
            />
          </div>
          {catalog?.error && s.model.provider === "copilot" && (
            <p className="text-xs text-danger sm:col-span-2">Couldn't list Copilot models ({catalog.error}). You can still type a model id.</p>
          )}
          {s.model.provider !== "copilot" && (
            <label className="grid gap-1.5 text-xs text-faint">
              Base URL
              <input className={input} value={s.model.baseUrl} placeholder="optional" onChange={(e) => setS({ ...s, model: { ...s.model, baseUrl: e.target.value } })} />
            </label>
          )}
          {s.model.provider !== "copilot" && (
            <label className="grid gap-1.5 text-xs text-faint sm:col-span-2">
              <span className="flex items-center gap-2">
                API key {s.model.hasApiKey && <Badge tone="olive">stored, encrypted</Badge>}
              </span>
              <input className={input} type="password" autoComplete="off" value={apiKey} placeholder={s.model.hasApiKey ? "•••••••• (leave blank to keep)" : "paste a key"} onChange={(e) => setApiKey(e.target.value)} />
            </label>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {s.model.hasApiKey && s.model.provider !== "copilot" && (
            <Button variant="ghost" size="sm" onClick={() => save({ apiKey: null }, "API key removed")}>
              Remove key
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              save(
                { model: { provider: s.model.provider, model: s.model.model, baseUrl: s.model.baseUrl }, models: { chat: s.models.chat, codingAgent: s.models.codingAgent }, ...(apiKey ? { apiKey } : {}) },
                "Models saved",
              ).then(refreshModels, () => {});
              setApiKey("");
            }}
          >
            Save model
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2">
          <Plug className="size-4" />
          <h2 className="font-medium">GitHub</h2>
          {s.github.connected ? <Badge tone="olive">connected as {s.github.login}</Badge> : <Badge tone="danger">not connected</Badge>}
          <span className="text-xs text-faint">via {s.github.source}</span>
        </div>
        <p className="mt-1 text-sm text-muted">
          Read access indexes your repos. Writes (issues, branches, draft PRs) only happen inside an approved swarm, on repos you allow. Uses the
          <span className="font-mono"> gh </span>CLI login or <span className="font-mono">GITHUB_TOKEN</span> unless you store a token here.
        </p>
        {!s.github.connected && s.github.error && <p className="mt-2 text-xs text-danger">{s.github.error}</p>}
        {!s.demo && (
          <div className="mt-4 flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="absolute left-3 top-2.5 size-4 text-faint" />
              <input className={cn(input, "pl-9")} type="password" autoComplete="off" value={ghToken} placeholder="Fine-grained token (optional)" onChange={(e) => setGhToken(e.target.value)} />
            </div>
            <Button
              size="sm"
              className="h-9"
              disabled={!ghToken}
              onClick={() => {
                save({ githubToken: ghToken }, "GitHub token saved");
                setGhToken("");
              }}
            >
              Save
            </Button>
            {s.github.source === "stored" && (
              <Button size="sm" variant="ghost" className="h-9" onClick={() => save({ githubToken: null }, "Stored token removed")}>
                Remove
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="font-medium">Gates and swarms</h2>
        <p className="mt-1 text-sm text-muted">Thresholds are on a 0–100 scale. Raising them means fewer, stronger recommendations.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {(
            [
              ["legitimacy", "Legitimacy pass mark"],
              ["priorFloor", "Evidence floor (no LLM override)"],
              ["soundness", "Soundness pass mark"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="grid gap-1.5 text-xs text-faint">
              {label}
              <input className={input} type="number" min={0} max={100} value={s.thresholds[k]} onChange={(e) => setS({ ...s, thresholds: { ...s.thresholds, [k]: num(e.target.value) } })} />
            </label>
          ))}
          {(
            [
              ["maxTasks", "Max tasks per swarm"],
              ["maxMinutes", "Max minutes"],
              ["maxAgentTurns", "Max agent turns"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="grid gap-1.5 text-xs text-faint">
              {label}
              <input className={input} type="number" min={1} value={s.budget[k]} onChange={(e) => setS({ ...s, budget: { ...s.budget, [k]: num(e.target.value) } })} />
            </label>
          ))}
          <label className="grid gap-1.5 text-xs text-faint sm:col-span-3">
            Default executor
            <select className={input} value={s.executor} onChange={(e) => setS({ ...s, executor: e.target.value })}>
              {s.demo && <option value="fake">Simulated (demo)</option>}
              {EXECUTORS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="primary" onClick={() => save({ thresholds: s.thresholds, budget: s.budget, executor: s.executor }, "Gates and budget saved")}>
            Save
          </Button>
        </div>
      </Card>
    </div>
  );
}
