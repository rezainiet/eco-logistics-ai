import { FraudSignal } from "@ecom/db";
import { adminProcedure, router } from "../trpc.js";
import { snapshotNetworkCounters } from "../../lib/observability/fraud-network.js";
import { env } from "../../env.js";

/**
 * Internal admin surface for the cross-merchant fraud network.
 *
 * Returns aggregate health + ROI metrics. Always admin-gated. Never
 * exposes per-merchant or per-fingerprint detail — the same privacy
 * boundary that protects merchant tenants from each other applies to
 * admins reading the dashboard.
 */
export const adminFraudNetworkRouter = router({
  getStats: adminProcedure.query(async () => {
    const decayCutoff = new Date(
      Date.now() - env.FRAUD_NETWORK_DECAY_DAYS * 86_400_000,
    );

    // Single aggregate pipeline — counts + sums + cardinality (via $unwind/$group)
    // in two passes for clarity. Cheap at our expected signal volumes.
    const [overview] = await FraudSignal.aggregate<{
      signalCount: number;
      freshSignalCount: number;
      deliveredCount: number;
      rtoCount: number;
      cancelledCount: number;
    }>([
      {
        $group: {
          _id: null,
          signalCount: { $sum: 1 },
          freshSignalCount: {
            $sum: { $cond: [{ $gte: ["$lastSeenAt", decayCutoff] }, 1, 0] },
          },
          deliveredCount: { $sum: "$deliveredCount" },
          rtoCount: { $sum: "$rtoCount" },
          cancelledCount: { $sum: "$cancelledCount" },
        },
      },
    ]);

    const [merchants] = await FraudSignal.aggregate<{ contributingMerchants: number }>([
      { $unwind: "$merchantIds" },
      { $group: { _id: "$merchantIds" } },
      { $count: "contributingMerchants" },
    ]);

    const totals = overview ?? {
      signalCount: 0,
      freshSignalCount: 0,
      deliveredCount: 0,
      rtoCount: 0,
      cancelledCount: 0,
    };
    const completed = totals.deliveredCount + totals.rtoCount;
    const avgRtoRate = completed > 0 ? totals.rtoCount / completed : 0;

    const counters = snapshotNetworkCounters();

    const warmingUp = totals.signalCount < env.FRAUD_NETWORK_WARMING_FLOOR;

    return {
      enabled: env.FRAUD_NETWORK_ENABLED,
      decayDays: env.FRAUD_NETWORK_DECAY_DAYS,
      warmingFloor: env.FRAUD_NETWORK_WARMING_FLOOR,
      warmingUp,
      // Persistent stats (sourced from Mongo).
      signals: {
        total: totals.signalCount,
        fresh: totals.freshSignalCount,
        stale: Math.max(0, totals.signalCount - totals.freshSignalCount),
        deliveredCount: totals.deliveredCount,
        rtoCount: totals.rtoCount,
        cancelledCount: totals.cancelledCount,
        avgRtoRate,
      },
      merchants: {
        contributing: merchants?.contributingMerchants ?? 0,
      },
      // In-process counters (sourced from observability — reset on deploy).
      counters,
    };
  }),
});
