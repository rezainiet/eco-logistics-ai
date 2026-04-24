export const palette = {
  base: {
    darker: "#0B0E1A",
    dark: "#111318",
    surface: "#1A1D2E",
    surfaceHover: "#232738",
  },
  accent: {
    primary: "#0084D4",
    hover: "#0072BB",
    focus: "#0059A3",
    subtle: "rgba(0, 132, 212, 0.1)",
  },
  status: {
    success: "#10B981",
    warning: "#F59E0B",
    error: "#EF4444",
    info: "#3B82F6",
  },
  text: {
    primary: "#F3F4F6",
    secondary: "#D1D5DB",
    tertiary: "#9CA3AF",
    disabled: "#6B7280",
  },
  border: {
    light: "rgba(209, 213, 219, 0.08)",
    default: "rgba(209, 213, 219, 0.15)",
    strong: "rgba(209, 213, 219, 0.3)",
  },
} as const;

export const typography = {
  fonts: {
    primary: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  heading: {
    h1: { size: "32px", weight: 600, height: 1.2, letter: "-0.5px" },
    h2: { size: "24px", weight: 600, height: 1.33, letter: "-0.3px" },
    h3: { size: "18px", weight: 600, height: 1.44, letter: "0" },
    h4: { size: "16px", weight: 600, height: 1.5, letter: "0" },
  },
  body: {
    large: { size: "16px", weight: 400, height: 1.5 },
    base: { size: "14px", weight: 400, height: 1.57 },
    small: { size: "12px", weight: 400, height: 1.67 },
    xsmall: { size: "11px", weight: 400, height: 1.73 },
  },
  label: {
    size: "11px",
    weight: 600,
    letter: "0.4px",
    transform: "uppercase" as const,
  },
} as const;

export const motion = {
  duration: { instant: 0, fast: 0.1, normal: 0.15, slow: 0.2, slower: 0.3 },
  easing: {
    easeOut: [0, 0, 0.2, 1] as const,
    easeInOut: [0.4, 0, 0.2, 1] as const,
  },
} as const;

export const shadows = {
  sm: "0 1px 3px 0 rgba(0, 0, 0, 0.1)",
  md: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
  lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
  glow: "0 0 12px rgba(0, 132, 212, 0.15)",
} as const;
