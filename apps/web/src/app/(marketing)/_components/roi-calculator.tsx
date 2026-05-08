"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

/**
 * Interactive ROI calculator for the marketing landing.
 *
 * Inputs: monthly orders, average order value (BDT), current RTO%.
 * Output: an estimate of avoidable RTO bleed under operator-driven
 * confirmation workflows. The reduction constant is an estimate-builder
 * default; actual reduction varies by store, product mix, and operator
 * staffing. The component uses pure useState — no third-party UI deps
 * — so the JS payload stays tiny and the marketing route remains light.
 */

const fmt = new Intl.NumberFormat("en-IN");
// Estimate-builder default — operator-tested baseline used by the
// calculator UI. Not surfaced to the merchant as a hard claim;
// the user-facing hint frames it as "based on operator-tested
// confirmation workflows; actual reduction varies by store".
const RTO_REDUCTION = 0.6;

type PlanRec = { name: string; price: number | null; tag: string };

function recommendPlan(orders: number): PlanRec {
  if (orders < 500) return { name: "Starter", price: 1990, tag: "up to 500/mo" };
  if (orders < 5000) return { name: "Growth", price: 4990, tag: "500 — 5,000/mo" };
  if (orders < 25000) return { name: "Scale", price: 12990, tag: "5,000 — 25,000/mo" };
  return { name: "Enterprise", price: null, tag: "25,000+/mo" };
}

export function RoiCalculator() {
  const [orders, setOrders] = useState(1500);
  const [aov, setAov] = useState(1200);
  const [rto, setRto] = useState(18);

  const calc = useMemo(() => {
    const monthlyBleed = orders * aov * (rto / 100);
    const remaining = monthlyBleed * (1 - RTO_REDUCTION);
    const monthlySavings = monthlyBleed - remaining;
    const annualSavings = monthlySavings * 12;
    const plan = recommendPlan(orders);
    const netMonthly =
      plan.price === null ? null : monthlySavings - plan.price;
    // ROI multiple — how many times subscription cost is returned
    // each month. Capped at 99x for display sanity.
    const roiMultiple =
      plan.price && plan.price > 0
        ? Math.min(99, Math.floor(monthlySavings / plan.price))
        : null;
    return {
      monthlyBleed,
      remaining,
      monthlySavings,
      annualSavings,
      plan,
      netMonthly,
      roiMultiple,
    };
  }, [orders, aov, rto]);

  // Broadcast the snapshot so FloatingLossIndicator + PricingHighlighter
  // (mounted elsewhere on the page) can react. We also stash the latest
  // snapshot on `window` so late-mounting listeners can read state-of-
  // the-world rather than waiting for the next slider event.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const detail = {
      monthlyBleed: calc.monthlyBleed,
      monthlySavings: calc.monthlySavings,
      plan: calc.plan.name,
    };
    (window as unknown as { __confirmxCalc?: typeof detail }).__confirmxCalc = detail;
    window.dispatchEvent(new CustomEvent("confirmx:calc-update", { detail }));
  }, [calc.monthlyBleed, calc.monthlySavings, calc.plan.name]);

  return (
    <div className="roi-calc">
      <div className="roi-inputs">
        <Slider
          label="Monthly orders"
          value={orders}
          min={100}
          max={50000}
          step={100}
          onChange={setOrders}
          format={(v) => fmt.format(v)}
        />
        <NumberField
          label="Average order value"
          unit="৳"
          value={aov}
          min={100}
          max={50000}
          onChange={setAov}
        />
        <Slider
          label="Current RTO rate"
          value={rto}
          min={3}
          max={40}
          step={1}
          onChange={setRto}
          format={(v) => `${v}%`}
        />
      </div>

      <div className="roi-outputs">
        <Output
          label="Monthly bleed today"
          value={`৳${fmt.format(Math.round(calc.monthlyBleed))}`}
          tone="danger"
        />
        <Output
          label="Estimated bleed with ConfirmX"
          value={`৳${fmt.format(Math.round(calc.remaining))}`}
          tone="muted"
          hint="based on operator-tested confirmation workflows; actual reduction varies by store"
        />
        <Output
          label="You save / month"
          value={`৳${fmt.format(Math.round(calc.monthlySavings))}`}
          tone="accent"
          big
        />
        <Output
          label="You save / year"
          value={`৳${fmt.format(Math.round(calc.annualSavings))}`}
          tone="accent"
          big
        />
      </div>

      <div className="roi-rec">
        <div className="roi-rec-row">
          <span className="roi-rec-label">Plan that fits you</span>
          <span className="roi-rec-value">
            <strong>{calc.plan.name}</strong>
            <span className="roi-rec-tag"> · {calc.plan.tag}</span>
            {calc.plan.price !== null && (
              <span className="roi-rec-price">
                {" "}
                · ৳{fmt.format(calc.plan.price)}/mo
              </span>
            )}
          </span>
        </div>
        {calc.netMonthly !== null && calc.netMonthly > 0 && (
          <div className="roi-rec-row">
            <span className="roi-rec-label">Net gain after subscription</span>
            <span className="roi-rec-value roi-rec-net">
              <strong>৳{fmt.format(Math.round(calc.netMonthly))}</strong>
              <span className="roi-rec-tag"> /month</span>
            </span>
          </div>
        )}
        {calc.roiMultiple !== null && calc.roiMultiple > 0 && (
          <div className="roi-multiple">
            <span className="roi-multiple-num">{calc.roiMultiple}×</span>
            <span className="roi-multiple-label">
              return on subscription, every month
            </span>
          </div>
        )}
      </div>

      <div className="roi-cta">
        <Link href="/signup" className="btn btn-primary btn-lg">
          Stop the ৳{fmt.format(Math.round(calc.monthlySavings))}/mo bleed{" "}
          <span className="arrow">→</span>
        </Link>
        <span className="roi-cta-note">
          14-day trial · cancel anytime · no card required
        </span>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  format: (n: number) => string;
}) {
  return (
    <label className="roi-slider">
      <div className="roi-field-head">
        <span className="roi-field-label">{label}</span>
        <span className="roi-field-value">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function NumberField({
  label,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="roi-numfield">
      <div className="roi-field-head">
        <span className="roi-field-label">{label}</span>
        <span className="roi-field-value">
          {unit}
          {fmt.format(value)}
        </span>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
      />
    </label>
  );
}

function Output({
  label,
  value,
  tone,
  big,
  hint,
}: {
  label: string;
  value: string;
  tone: "danger" | "accent" | "muted";
  big?: boolean;
  hint?: string;
}) {
  return (
    <div className={`roi-output roi-output-${tone}${big ? " roi-output-big" : ""}`}>
      <div className="roi-output-label">{label}</div>
      <div className="roi-output-value">{value}</div>
      {hint && <div className="roi-output-hint">{hint}</div>}
    </div>
  );
}
