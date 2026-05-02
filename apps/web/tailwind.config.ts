import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  presets: [require("../../packages/config/tailwind.js")],
  content: ["./src/app/**/*.{ts,tsx}", "./src/components/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.02em" }],
      },
      colors: {
        // Legacy shadcn tokens — kept so radix/shadcn primitives keep working.
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Semantic surfaces (new). Use <alpha-value> so bg-surface/60 etc. work.
        surface: {
          base: "hsl(var(--surface-base) / <alpha-value>)",
          DEFAULT: "hsl(var(--surface) / <alpha-value>)",
          raised: "hsl(var(--surface-raised) / <alpha-value>)",
          overlay: "hsl(var(--surface-overlay) / <alpha-value>)",
          hover: "hsl(var(--surface-hover) / <alpha-value>)",
        },
        // Semantic foregrounds (new).
        fg: {
          DEFAULT: "hsl(var(--fg) / <alpha-value>)",
          muted: "hsl(var(--fg-muted) / <alpha-value>)",
          subtle: "hsl(var(--fg-subtle) / <alpha-value>)",
          faint: "hsl(var(--fg-faint) / <alpha-value>)",
        },
        // Semantic strokes (new).
        stroke: {
          subtle: "hsl(var(--stroke-subtle) / <alpha-value>)",
          DEFAULT: "hsl(var(--stroke-default) / <alpha-value>)",
          strong: "hsl(var(--stroke-strong) / <alpha-value>)",
        },
        brand: {
          DEFAULT: "hsl(var(--brand) / <alpha-value>)",
          hover: "hsl(var(--brand-hover) / <alpha-value>)",
          active: "hsl(var(--brand-active) / <alpha-value>)",
          fg: "hsl(var(--brand-fg) / <alpha-value>)",
          subtle: "hsl(var(--brand) / 0.1)",
          surface: "hsl(var(--brand) / 0.14)",
          border: "hsl(var(--brand) / 0.35)",
          // Legacy alias.
          focus: "hsl(var(--brand-active) / <alpha-value>)",
        },
        success: {
          DEFAULT: "hsl(var(--success) / <alpha-value>)",
          subtle: "hsl(var(--success) / 0.12)",
          border: "hsl(var(--success) / 0.35)",
          fg: "hsl(var(--success) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--warning) / <alpha-value>)",
          subtle: "hsl(var(--warning) / 0.12)",
          border: "hsl(var(--warning) / 0.35)",
          fg: "hsl(var(--warning) / <alpha-value>)",
        },
        danger: {
          DEFAULT: "hsl(var(--danger) / <alpha-value>)",
          subtle: "hsl(var(--danger) / 0.1)",
          border: "hsl(var(--danger) / 0.35)",
          fg: "hsl(var(--danger) / <alpha-value>)",
        },
        info: {
          DEFAULT: "hsl(var(--info) / <alpha-value>)",
          subtle: "hsl(var(--info) / 0.12)",
          border: "hsl(var(--info) / 0.35)",
          fg: "hsl(var(--info) / <alpha-value>)",
        },
        // Legacy — preserved so existing `bg-dark-bg` etc. still resolve.
        "dark-bg": "hsl(var(--surface-base))",
        "dark-surface": "hsl(var(--surface))",
        "dark-surface-hover": "hsl(var(--surface-hover))",
        status: {
          success: "hsl(var(--success))",
          warning: "hsl(var(--warning))",
          error: "hsl(var(--danger))",
          info: "hsl(var(--info))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgba(0,0,0,0.35), 0 1px 3px -1px rgba(0,0,0,0.25)",
        elevated:
          "0 2px 4px -1px rgba(0,0,0,0.35), 0 8px 24px -6px rgba(0,0,0,0.45), 0 0 0 1px hsl(var(--stroke-subtle))",
        raised:
          "0 12px 32px -12px rgba(0,0,0,0.55), 0 6px 16px -6px rgba(0,0,0,0.4), 0 0 0 1px hsl(var(--stroke-subtle))",
        popover:
          "0 18px 48px -12px rgba(0,0,0,0.65), 0 8px 20px -8px rgba(0,0,0,0.45), 0 0 0 1px hsl(var(--stroke-subtle))",
        focus: "0 0 0 3px hsl(var(--brand) / 0.3)",
        glow: "0 0 12px rgba(0, 132, 212, 0.15)",
        "glow-strong": "0 0 24px rgba(0, 132, 212, 0.3)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 160ms ease-out both",
        "slide-up": "slide-up 220ms cubic-bezier(0,0,0.2,1) both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
