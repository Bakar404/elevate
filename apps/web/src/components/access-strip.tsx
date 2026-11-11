import { ECOSYSTEM_LABEL, type Ecosystem } from "@elevate/engine";
import { SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** One line saying whose news this is: what the user has connected, and how much was set aside because of it. */
export function AccessStrip({ ecosystems, setAside, className }: { ecosystems: Ecosystem[]; setAside: number; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)} data-testid="access-strip">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-faint">
        <SlidersHorizontal className="size-3.5" aria-hidden /> Tuned for
      </span>
      <div className="rail flex min-w-0 max-w-full items-center gap-1.5 overflow-x-auto py-1">
        {ecosystems.length ? (
          ecosystems.map((e) => (
            <span key={e} className="shrink-0 rounded-full border border-sky/30 bg-sky/10 px-2.5 py-1 text-xs text-sky">
              {ECOSYSTEM_LABEL[e]}
            </span>
          ))
        ) : (
          <span className="shrink-0 text-xs text-muted">no AI products yet</span>
        )}
      </div>
      {setAside > 0 && (
        <Link href="/radar?show=setaside" className="shrink-0 px-1 text-xs text-muted underline decoration-line-strong underline-offset-4 hover:text-fg">
        {setAside} set aside
        </Link>
      )}
      <Link href="/settings#access" className="shrink-0 px-1 text-xs text-faint underline decoration-line-strong underline-offset-4 hover:text-fg">
        Change
      </Link>
    </div>
  );
}
