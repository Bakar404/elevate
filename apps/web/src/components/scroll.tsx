"use client";

import { ArrowUp } from "lucide-react";
import { motion, useScroll, useSpring } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { prefersReducedMotion, usePrefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Thin bar along the top of the page that fills as you scroll. */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 220, damping: 32, restDelta: 0.001 });
  return (
    <motion.div
      aria-hidden
      data-testid="scroll-progress"
      style={{ scaleX }}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 origin-left bg-gradient-to-r from-sky via-olive to-sand"
    />
  );
}

/** Fades a section in the first time it scrolls into view. */
export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = usePrefersReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -60px 0px" }}
      transition={{ duration: 0.45, ease: [0.23, 1, 0.32, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

/** Appears after a screen of scrolling. */
export function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(window.scrollY > window.innerHeight);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <button
      type="button"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" })}
      className={cn(
        "fixed bottom-6 right-6 z-40 max-md:bottom-[calc(5rem+env(safe-area-inset-bottom))] max-md:right-4 grid size-10 place-items-center rounded-full border border-line-strong bg-raised/80 text-muted shadow-lg backdrop-blur transition-[opacity,transform,color] duration-200 hover:text-fg",
        show ? "opacity-100" : "pointer-events-none translate-y-2 opacity-0",
      )}
    >
      <ArrowUp className="size-4" />
    </button>
  );
}
