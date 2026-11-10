"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { LOGO_COOKIE, LOGO_INFO, LOGO_VARIANTS, setPrefCookie, type LogoVariant } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { Logo, LogoMark } from "./logo";
import { Button, SpotlightCard } from "./ui";

export function LogoPicker({ current }: { current: LogoVariant }) {
  const [picked, setPicked] = useState(current);
  const router = useRouter();
  const choose = (v: LogoVariant) => {
    setPicked(v);
    setPrefCookie(LOGO_COOKIE, v);
    router.refresh();
    toast.success(`Using “${LOGO_INFO[v].name}”`);
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {LOGO_VARIANTS.map((v, i) => {
        const on = v === picked;
        return (
          <SpotlightCard key={v} data-testid={`logo-${v}`} className={cn("animate-fade-up p-5", on && "border-sky/50")} style={{ animationDelay: `${i * 50}ms` }}>
            <div className="flex items-start justify-between">
              <LogoMark variant={v} size={72} />
              <span className="font-mono text-xs text-faint">0{i + 1}</span>
            </div>
            <div className="mt-5 flex items-center gap-2">
              <span className="font-medium">{LOGO_INFO[v].name}</span>
              {on && <Check className="size-4 text-sky" />}
            </div>
            <p className="mt-1 min-h-10 text-sm text-muted">{LOGO_INFO[v].idea}</p>
            <div className="mt-4 flex items-center gap-4 rounded-xl border border-line bg-bg/60 px-3 py-2.5">
              <Logo variant={v} size={24} />
              <span className="ml-auto flex items-center gap-2">
                <LogoMark variant={v} size={20} />
                <LogoMark variant={v} size={16} />
              </span>
            </div>
            <Button className="mt-4 w-full" variant={on ? "secondary" : "primary"} size="sm" disabled={on} onClick={() => choose(v)}>
              {on ? "In use" : "Use this"}
            </Button>
          </SpotlightCard>
        );
      })}
    </div>
  );
}
