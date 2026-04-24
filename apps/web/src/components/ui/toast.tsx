"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

type ToastVariant = "success" | "error" | "info";

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  durationMs: number;
}

type Listener = (toasts: Toast[]) => void;

const listeners = new Set<Listener>();
let state: Toast[] = [];

function emit(): void {
  for (const l of listeners) l(state);
}

function push(input: Omit<Toast, "id">): string {
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state = [...state, { ...input, id }];
  emit();
  return id;
}

function dismiss(id: string): void {
  state = state.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success(title: string, description?: string) {
    return push({ title, description, variant: "success", durationMs: 4500 });
  },
  error(title: string, description?: string) {
    return push({ title, description, variant: "error", durationMs: 6000 });
  },
  info(title: string, description?: string) {
    return push({ title, description, variant: "info", durationMs: 4500 });
  },
  dismiss,
};

const variantStyles: Record<ToastVariant, { border: string; icon: JSX.Element; title: string }> = {
  success: {
    border: "border-[rgba(16,185,129,0.3)]",
    icon: <CheckCircle2 className="h-5 w-5 text-[#10B981]" />,
    title: "text-[#10B981]",
  },
  error: {
    border: "border-[rgba(248,113,113,0.35)]",
    icon: <TriangleAlert className="h-5 w-5 text-[#F87171]" />,
    title: "text-[#F87171]",
  },
  info: {
    border: "border-[rgba(0,132,212,0.35)]",
    icon: <Info className="h-5 w-5 text-[#60A5FA]" />,
    title: "text-[#60A5FA]",
  },
};

export function Toaster() {
  const [items, setItems] = useState<Toast[]>(state);

  useEffect(() => {
    const listener: Listener = (next) => setItems([...next]);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const timers = items.map((t) =>
      setTimeout(() => dismiss(t.id), t.durationMs),
    );
    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, [items]);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      <AnimatePresence initial={false}>
        {items.map((t) => {
          const v = variantStyles[t.variant];
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 40, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96, transition: { duration: 0.15 } }}
              transition={{ type: "spring", stiffness: 320, damping: 28 }}
              className={`pointer-events-auto flex items-start gap-3 rounded-lg border ${v.border} bg-[#1A1D2E] p-3 shadow-lg shadow-black/30`}
            >
              <div className="mt-0.5">{v.icon}</div>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-semibold ${v.title}`}>{t.title}</p>
                {t.description && (
                  <p className="mt-0.5 text-sm text-[#D1D5DB]">{t.description}</p>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="text-[#9CA3AF] transition-colors hover:text-[#F3F4F6]"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
