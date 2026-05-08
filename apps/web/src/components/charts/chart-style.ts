// Chart palette resolves to the live Cordon brand (lime). Previously the
// `brand` and cursor-fill swatches were the dead Logistics blue
// (hsl 202°), which painted KPI sparklines + bar charts blue while the
// rest of the app rendered the rebranded lime. Audit § "Brand drift"
// (2026-05-09) — fixed by aligning chart bars to --brand.
export const CHART_COLORS = {
  brand: "hsl(76 92% 64%)",
  success: "hsl(160 84% 39%)",
  warning: "hsl(38 92% 50%)",
  danger: "hsl(0 84% 60%)",
  info: "hsl(217 91% 60%)",
  violet: "hsl(262 83% 62%)",
  muted: "hsl(220 11% 64%)",
} as const;

export const CHART_GRID_STROKE = "hsl(220 13% 85% / 0.08)";
export const CHART_AXIS_STROKE = "hsl(220 11% 64%)";
export const CHART_CURSOR_FILL = "hsl(76 92% 64% / 0.10)";

export const CHART_TOOLTIP_STYLE = {
  backgroundColor: "hsl(228 30% 11% / 0.96)",
  backdropFilter: "blur(8px)",
  border: "1px solid hsl(220 13% 85% / 0.12)",
  borderRadius: "10px",
  color: "hsl(220 13% 96%)",
  fontSize: "12px",
  padding: "8px 10px",
  boxShadow: "0 10px 30px -12px rgba(0,0,0,0.55)",
} as const;

export const CHART_LEGEND_STYLE = {
  color: "hsl(220 11% 64%)",
  fontSize: 11,
  paddingTop: 8,
} as const;
