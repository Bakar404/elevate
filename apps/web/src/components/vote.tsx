"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn, send } from "@/lib/utils";

export type Vote = "like" | "dislike" | "none";
const voteOf = (feedback: number | null): Vote => (feedback === 1 ? "like" : feedback === -1 ? "dislike" : "none");

function noted(next: Vote, status: string) {
  if (next === "like") return "Liked. elevate will rank ideas like this first.";
  if (next === "dislike") return status === "open" ? "Disliked. Moved to Filtered out, and you'll see fewer like it." : "Disliked. You'll see fewer like it.";
  return "Vote taken back.";
}

/**
 * Thumbs up and down on a recommendation. Votes train the ranking (see packages/engine/src/learner.ts):
 * likes move similar ideas up, and a dislike moves this one to Filtered out. Clicking a vote again takes it back.
 */
export function VoteButtons({ id, feedback, status, labels = false, className }: { id: string; feedback: number | null; status: string; labels?: boolean; className?: string }) {
  const router = useRouter();
  const [vote, setVote] = useState<Vote>(voteOf(feedback));
  const [busy, setBusy] = useState(false);
  useEffect(() => setVote(voteOf(feedback)), [feedback]);

  const cast = async (next: Vote, quiet = false) => {
    const before = vote;
    setVote(next);
    setBusy(true);
    try {
      await send(`/api/recommendations/${id}/feedback`, { vote: next });
      router.refresh();
      if (!quiet) toast.success(noted(next, status), { action: { label: "Undo", onClick: () => void cast(before, true) } });
    } catch (e) {
      setVote(before);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const button = (v: Exclude<Vote, "none">) => {
    const on = vote === v;
    const Icon = v === "like" ? ThumbsUp : ThumbsDown;
    const label = v === "like" ? "Like" : "Dislike";
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={labels ? undefined : label}
        title={on ? `Take back your ${v}` : v === "like" ? "More like this" : "Less like this"}
        data-testid={`vote-${v}`}
        disabled={busy}
        onClick={() => void cast(on ? "none" : v)}
        className={cn(
          "relative z-10 inline-flex items-center gap-1.5 rounded-lg border text-xs transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.94] disabled:opacity-60",
          labels ? "h-9 px-3 text-sm" : "size-8 justify-center",
          on
            ? v === "like"
              ? "border-olive/50 bg-olive/15 text-olive"
              : "border-sand/50 bg-sand/15 text-sand"
            : "border-line text-faint hover:border-line-strong hover:text-fg",
        )}
      >
        <Icon className={cn("size-4", on && "fill-current/25")} aria-hidden />
        {labels && label}
      </button>
    );
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)} role="group" aria-label="Your vote" data-vote={vote}>
      {button("like")}
      {button("dislike")}
    </div>
  );
}
