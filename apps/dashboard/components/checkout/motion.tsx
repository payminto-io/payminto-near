"use client";

/**
 * Motion for the hosted checkout (PRODUCT.md section 6.3), built on `motion/react`.
 * Everything here respects prefers-reduced-motion: MotionConfig drops transforms for those payers, and the pieces that
 * only decorate (particles, sweeps, shimmer, shake) are not rendered at all.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, motion, MotionConfig, type Transition, type Variants } from "motion/react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** The "out" curve from the brief: fast start, soft landing. */
export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;
export const T = {
  fast: { duration: 0.15, ease: EASE_OUT } satisfies Transition,
  base: { duration: 0.22, ease: EASE_OUT } satisfies Transition,
  slow: { duration: 0.32, ease: EASE_OUT } satisfies Transition,
  spring: { type: "spring", stiffness: 260, damping: 22 } satisfies Transition,
};

export function CheckoutMotion({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={T.base}>
      <ToastProvider>{children}</ToastProvider>
    </MotionConfig>
  );
}

const REDUCE = "(prefers-reduced-motion: reduce)";
function subscribeReduce(onChange: () => void): () => void {
  const mq = window.matchMedia(REDUCE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * True when the payer asked for less motion; decorative motion is then skipped entirely. The server cannot know, so
 * hydration renders as the server did and the reduced tree follows on the next render, never a hydration mismatch.
 */
export function useCalm(): boolean {
  return useSyncExternalStore(subscribeReduce, () => window.matchMedia(REDUCE).matches, () => false);
}

// ---------------------------------------------------------------------------
// Entrance stagger
// ---------------------------------------------------------------------------

const staggerParent: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.04, delayChildren: 0.06 } } };
const staggerChild: Variants = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: T.slow } };

export function Stagger({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "ul" | "dl" }) {
  const C = as === "ul" ? motion.ul : as === "dl" ? motion.dl : motion.div;
  return (
    <C variants={staggerParent} initial="hidden" animate="show" className={className}>
      {children}
    </C>
  );
}

export function StaggerItem({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "li" }) {
  const C = as === "li" ? motion.li : motion.div;
  return (
    <C variants={staggerChild} className={className}>
      {children}
    </C>
  );
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * Text whose digits roll vertically when they change (fee re-quote, "Still to pay" counting down, the countdown).
 * Screen readers get the plain text once, never the moving parts.
 */
export function RollingText({ text, className }: { text: string; className?: string }) {
  const calm = useCalm();
  if (calm) return <span className={cn("num", className)}>{text}</span>;
  const chars = text.split("");
  return (
    <span className={cn("num relative inline-flex overflow-hidden", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex">
        {chars.map((ch, i) => {
          // Keyed from the right so the units digit stays the units digit when the length changes.
          const slot = chars.length - i;
          return /\d/.test(ch) ? (
            <span key={`d${slot}`} className="relative inline-block overflow-hidden">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={ch}
                  className="inline-block"
                  initial={{ y: "-70%", opacity: 0 }}
                  animate={{ y: "0%", opacity: 1 }}
                  exit={{ y: "70%", opacity: 0 }}
                  transition={{ duration: 0.3, ease: EASE_OUT }}
                >
                  {ch}
                </motion.span>
              </AnimatePresence>
            </span>
          ) : (
            <span key={`c${slot}${ch}`} className="inline-block whitespace-pre">
              {ch}
            </span>
          );
        })}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rings, bars and the success mark
// ---------------------------------------------------------------------------

/** A circular progress ring drawn with stroke length; children sit in the middle. */
export function ProgressRing({
  fraction,
  size = 88,
  stroke = 4,
  className,
  trackClassName = "text-border",
  barClassName = "text-[var(--ink)]",
  children,
  label,
}: {
  fraction: number;
  size?: number;
  stroke?: number;
  className?: string;
  trackClassName?: string;
  barClassName?: string;
  children?: ReactNode;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
      role={label ? "progressbar" : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label ? Math.round(fraction * 100) : undefined}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className={trackClassName} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          className={barClassName}
          initial={false}
          animate={{ pathLength: Math.max(0.001, Math.min(1, fraction)) }}
          transition={{ duration: 0.6, ease: EASE_OUT }}
        />
      </svg>
      <span className="relative flex items-center justify-center">{children}</span>
    </span>
  );
}

/**
 * The paid moment: a ring closes, a check draws inside it, the disc washes to the positive colour, and twelve small
 * particles in the brand colour burst once. Under 900 ms in all; reduced motion shows the finished mark.
 */
export function SuccessMark({ size = 72, celebrate = true }: { size?: number; celebrate?: boolean }) {
  const calm = useCalm();
  const r = size / 2 - 3;
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }} aria-hidden>
      {celebrate && !calm && <ParticleBurst size={size} />}
      <motion.span
        className="absolute inset-0 rounded-full bg-positive"
        initial={calm ? false : { scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ ...T.spring, delay: 0.42 }}
      />
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="relative">
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--positive)"
          strokeWidth={3}
          strokeLinecap="round"
          initial={calm ? false : { pathLength: 0, rotate: -90 }}
          animate={{ pathLength: 1, rotate: -90 }}
          style={{ originX: "50%", originY: "50%" }}
          transition={{ duration: 0.42, ease: EASE_OUT }}
        />
        <motion.path
          d={`M ${size * 0.3} ${size * 0.52} L ${size * 0.44} ${size * 0.65} L ${size * 0.71} ${size * 0.37}`}
          fill="none"
          stroke="var(--card)"
          strokeWidth={size / 14}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={calm ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.32, ease: EASE_OUT, delay: 0.5 }}
        />
      </svg>
    </span>
  );
}

function ParticleBurst({ size }: { size: number }) {
  const n = 12;
  return (
    <span className="pointer-events-none absolute inset-0">
      {Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + (i % 2 ? 0.18 : 0);
        const d = size * (i % 3 === 0 ? 0.95 : 0.78);
        return (
          <motion.span
            key={i}
            className={cn("absolute top-1/2 left-1/2 -mt-[3px] -ml-[3px] size-1.5", i % 3 === 1 ? "rounded-[1px]" : "rounded-full", i % 4 === 0 ? "bg-positive" : "bg-[var(--ink)]")}
            initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
            animate={{ x: Math.cos(a) * d, y: Math.sin(a) * d, opacity: [0, 1, 0], scale: [0.4, 1, 0.6] }}
            transition={{ duration: 0.7, ease: EASE_OUT, delay: 0.5, times: [0, 0.3, 1] }}
          />
        );
      })}
    </span>
  );
}

/** A thin bar that fills to a fraction; used for partly paid, the time left and the return countdown. */
export function Bar({ fraction, className, barClassName, linear = false }: { fraction: number; className?: string; barClassName?: string; linear?: boolean }) {
  return (
    <span className={cn("block h-1.5 overflow-hidden rounded-full bg-muted", className)} aria-hidden>
      <motion.span
        className={cn("block h-full origin-left rounded-full", barClassName)}
        initial={false}
        animate={{ scaleX: Math.max(0, Math.min(1, fraction)) }}
        transition={linear ? { duration: 1, ease: "linear" } : { duration: 0.5, ease: EASE_OUT }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Swaps and loops
// ---------------------------------------------------------------------------

/** Cross-fades between keyed children, with an optional small shift; the parent keeps its size. */
export function Swap({ id, children, className, shift = 0, mode = "wait" }: { id: string; children: ReactNode; className?: string; shift?: number; mode?: "wait" | "popLayout" | "sync" }) {
  return (
    <AnimatePresence mode={mode} initial={false}>
      <motion.div key={id} className={className} initial={{ opacity: 0, x: shift, y: shift ? 0 : 4 }} animate={{ opacity: 1, x: 0, y: 0 }} exit={{ opacity: 0, x: -shift, y: shift ? 0 : -4 }} transition={T.base}>
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/** Placeholder shimmer until data arrives. */
export function Shimmer({ className }: { className?: string }) {
  const calm = useCalm();
  return (
    <span className={cn("relative block overflow-hidden rounded-md bg-muted", className)} aria-hidden>
      {!calm && (
        <motion.span
          className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-white/50 to-transparent dark:via-white/10"
          animate={{ x: ["0%", "400%"] }}
          transition={{ duration: 1.2, ease: "linear", repeat: Infinity }}
        />
      )}
    </span>
  );
}

/** A dot that pulses outwards: live (positive) or reconnecting (amber). */
export function PulseDot({ className }: { className?: string }) {
  const calm = useCalm();
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      {!calm && (
        <motion.span className="absolute inset-0 rounded-full bg-current" animate={{ scale: [1, 2.4], opacity: [0.5, 0] }} transition={{ duration: 1.6, ease: "easeOut", repeat: Infinity }} />
      )}
      <span className="relative size-2 rounded-full bg-current" />
    </span>
  );
}

/** Shakes its child once whenever `token` changes (wrong network). */
export function ShakeOn({ token, children, className }: { token: number; children: ReactNode; className?: string }) {
  const calm = useCalm();
  return (
    <motion.div key={calm ? "calm" : token} className={className} initial={false} animate={token && !calm ? { x: [0, -4, 4, -3, 3, 0] } : { x: 0 }} transition={{ duration: 0.28, ease: "easeOut" }}>
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// "Copied" toast
// ---------------------------------------------------------------------------

const ToastContext = createContext<((text: string) => void) | null>(null);

function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ id: Date.now(), text });
    timer.current = setTimeout(() => setToast(null), 1400);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 flex justify-center lg:bottom-8" role="status" aria-live="polite">
        <AnimatePresence>
          {toast && (
            <motion.span
              key={toast.id}
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6 }}
              transition={T.base}
              className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-2 text-sm font-medium text-background shadow-lg"
            >
              <Check className="size-4" aria-hidden /> {toast.text}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

/** Shows the slide-up "Copied" toast when inside the checkout; a no-op elsewhere in the dashboard. */
export function useToast(): (text: string) => void {
  return useContext(ToastContext) ?? noop;
}
const noop = () => undefined;
