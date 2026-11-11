"use client";

import { Popover } from "@base-ui/react/popover";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Cpu } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type ModelOption = {
  id: string;
  name: string;
  vendor?: string;
  /** GitHub's price in USD per 1M tokens. */
  price?: { input: number; output: number; cachedInput?: number };
  multiplier?: number;
  discountPercent?: number;
  enabled: boolean;
};
export type ModelsResponse = { provider: string; models: ModelOption[]; error?: string; prefs: { pipeline: string; chat: string } };

let pending: Promise<ModelsResponse> | null = null;

/** Fetched once per page load and shared by every picker; `refresh` after Settings change the provider. */
export function useModels() {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const load = (fresh = false) => {
    if (fresh || !pending)
      pending = fetch("/api/models")
        .then((r) => r.json() as Promise<ModelsResponse>)
        .catch(() => ({ provider: "copilot", models: [], prefs: { pipeline: "", chat: "" }, error: "Could not load models" }));
    pending.then(setData);
  };
  useEffect(() => load(), []);
  return { data, refresh: () => load(true) };
}

const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(Math.round(n * 1000) % 10 ? 3 : 2)}`;

/** GitHub's own numbers only: per-token price (usage-based billing), legacy multiplier, or the auto discount. */
function cost(m: ModelOption): { text: string; title: string } | null {
  if (m.price)
    return {
      text: `${usd(m.price.input)} / ${usd(m.price.output)}`,
      title: `GitHub price per 1M tokens: ${usd(m.price.input)} input, ${usd(m.price.output)} output${m.price.cachedInput != null ? `, ${usd(m.price.cachedInput)} cached input` : ""}. Billed in GitHub AI Credits ($0.01 each).`,
    };
  if (m.multiplier != null) return { text: `${m.multiplier}×`, title: "Premium-request multiplier (legacy request-based billing)" };
  if (m.discountPercent) return { text: `−${m.discountPercent}%`, title: `GitHub discounts auto model selection by ${m.discountPercent}%` };
  return null;
}

/**
 * Searchable model menu. "" means "use the default", described by `defaultLabel`.
 * With a bring-your-own-key provider the list is empty, so whatever is typed can be used as the id.
 */
export function ModelPicker({
  value,
  onChange,
  models,
  defaultLabel,
  allowCustom = true,
  compact,
  label = "Model",
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  models: ModelOption[];
  defaultLabel: string;
  allowCustom?: boolean;
  compact?: boolean;
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = models.find((m) => m.id === value);
  const shown = value ? (current?.name ?? value) : defaultLabel;
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };
  const q = query.trim();
  const custom = allowCustom && q && !models.some((m) => m.id.toLowerCase() === q.toLowerCase());

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        disabled={disabled}
        aria-label={`${label}: ${shown}`}
        data-testid="model-picker"
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-line-strong text-left transition-colors hover:border-sky/40 disabled:opacity-50",
          compact ? "h-8 max-w-56 bg-transparent px-2 text-xs text-muted hover:text-fg" : "h-9 w-full bg-bg/60 px-3 text-sm",
        )}
      >
        <Cpu className={cn("shrink-0 text-faint", compact ? "size-3.5" : "size-4")} aria-hidden />
        <span className={cn("min-w-0 flex-1 truncate", !value && "text-muted")}>{shown}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-faint" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className="popup w-[min(92vw,22rem)] overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl">
            <Command label={label} loop>
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder={models.length ? "Search models…" : "Type a model id…"}
                className="h-10 w-full border-b border-line bg-transparent px-3 text-sm outline-none placeholder:text-faint"
              />
              <Command.List className="max-h-72 overflow-y-auto p-1.5">
                <Command.Empty className="px-3 py-4 text-center text-xs text-faint">No model matches.</Command.Empty>
                {models.some((m) => m.price) && (
                  <div className="flex justify-end px-2 pb-1 text-[10px] uppercase tracking-wide text-faint">$ per 1M tokens · in / out</div>
                )}
                <Row selected={!value} onSelect={() => pick("")} value={`default ${defaultLabel}`}>
                  <span className="truncate">{defaultLabel}</span>
                </Row>
                {models.map((m) => (
                  <Row
                    key={m.id}
                    value={`${m.name} ${m.id} ${m.vendor ?? ""}`}
                    selected={m.id === value}
                    disabled={!m.enabled}
                    onSelect={() => pick(m.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{m.name}</span>
                    {!m.enabled ? (
                      <span className="shrink-0 text-[11px] text-faint">off in policy</span>
                    ) : (
                      (() => {
                        const c = cost(m);
                        return (
                          c && (
                            <span title={c.title} className={cn("shrink-0 font-mono text-[11px] tabular-nums", m.discountPercent ? "text-olive" : "text-faint")}>
                              {c.text}
                            </span>
                          )
                        );
                      })()
                    )}
                  </Row>
                ))}
                {custom && (
                  <Row value={`custom ${q}`} selected={false} onSelect={() => pick(q)} forceMount>
                    <span className="truncate">
                      Use <span className="font-mono">{q}</span>
                    </span>
                  </Row>
                )}
              </Command.List>
            </Command>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({ selected, children, ...props }: React.ComponentProps<typeof Command.Item> & { selected: boolean }) {
  return (
    <Command.Item
      className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[selected=true]:bg-ink/[0.06] data-[selected=true]:text-fg"
      {...props}
    >
      <Check className={cn("size-3.5 shrink-0 text-sky", !selected && "invisible")} aria-hidden />
      {children}
    </Command.Item>
  );
}
