"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Eye,
  Filter,
  Inbox,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { formatBDT, formatDateTime } from "@/lib/formatters";

type PendingPayment = {
  id: string;
  createdAt: Date | string;
  merchantName: string;
  merchantEmail: string;
  plan: string;
  currentTier: string;
  method: string;
  provider?: "manual" | "stripe";
  amount: number;
  currency?: string;
  txnId: string | null;
  proofUrl: string | null;
  hasProofFile?: boolean;
  status: "pending" | "reviewed" | "approved" | "rejected";
  riskScore: number;
  riskReasons: string[];
  requiresDualApproval: boolean;
  firstApprovalBy: string | null;
};

export default function AdminBillingPage() {
  const [status, setStatus] = useState<
    "pending" | "reviewed" | "approved" | "rejected"
  >("pending");
  const [stepupDialog, setStepupDialog] = useState<{
    payment: PendingPayment | null;
    intent: "approve" | "reject";
    days: string;
    reason: string;
    password: string;
  }>({
    payment: null,
    intent: "approve",
    days: "30",
    reason: "",
    password: "",
  });

  const [highRiskOnly, setHighRiskOnly] = useState(false);

  const list = trpc.adminBilling.listPendingPayments.useQuery({
    status,
    limit: 100,
  });
  const overview = trpc.adminObservability.paymentOverview.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const utils = trpc.useUtils();

  const markReviewed = trpc.adminBilling.markReviewed.useMutation({
    onSuccess: () => {
      toast.success("Marked reviewed", "Ready for final approval.");
      utils.adminBilling.listPendingPayments.invalidate();
    },
    onError: (err) => toast.error("Mark reviewed failed", err.message),
  });

  const issueStepup = trpc.adminAccess.issueStepup.useMutation();
  const approve = trpc.adminBilling.approvePayment.useMutation({
    onSuccess: (res) => {
      if (res.stage === "first_approval") {
        toast.success(
          "First approval recorded",
          "A different admin must complete the second approval.",
        );
      } else {
        toast.success("Approved", "Subscription activated.");
      }
      setStepupDialog((s) => ({ ...s, payment: null, password: "" }));
      utils.adminBilling.listPendingPayments.invalidate();
    },
    onError: (err) => toast.error("Approval failed", err.message),
  });
  const reject = trpc.adminBilling.rejectPayment.useMutation({
    onSuccess: () => {
      toast.success("Rejected");
      setStepupDialog((s) => ({ ...s, payment: null, password: "" }));
      utils.adminBilling.listPendingPayments.invalidate();
    },
    onError: (err) => toast.error("Rejection failed", err.message),
  });

  const allPayments = (list.data ?? []) as PendingPayment[];
  const payments = useMemo(
    () =>
      highRiskOnly
        ? allPayments.filter(
            (p) => (p.riskScore ?? 0) >= 60 || p.requiresDualApproval,
          )
        : allPayments,
    [allPayments, highRiskOnly],
  );

  async function performStepupAction() {
    const { payment, intent, days, reason, password } = stepupDialog;
    if (!payment) return;
    if (!password) {
      toast.error("Enter your password to confirm");
      return;
    }
    try {
      const { token } = await issueStepup.mutateAsync({
        permission: intent === "approve" ? "payment.approve" : "payment.reject",
        password,
      });
      if (intent === "approve") {
        const d = Number(days);
        if (!Number.isFinite(d) || d <= 0) {
          toast.error("Enter positive billing period days");
          return;
        }
        await approve.mutateAsync({
          paymentId: payment.id,
          periodDays: d,
          confirmationToken: token,
        });
      } else {
        if (!reason.trim()) {
          toast.error("Enter a rejection reason");
          return;
        }
        await reject.mutateAsync({
          paymentId: payment.id,
          reason: reason.trim(),
          confirmationToken: token,
        });
      }
    } catch (err) {
      toast.error("Step-up failed", (err as Error).message);
    }
  }

  function openApproveDialog(p: PendingPayment) {
    setStepupDialog({
      payment: p,
      intent: "approve",
      days: "30",
      reason: "",
      password: "",
    });
  }
  function openRejectDialog(p: PendingPayment) {
    setStepupDialog({
      payment: p,
      intent: "reject",
      days: "30",
      reason: "",
      password: "",
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Payment risk queue"
        description="Two-stage workflow: review first, then approve. High-risk payments (score ≥ 60) require a second admin's sign-off."
      />

      {/* Summary band */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          icon={Inbox}
          label="Pending today"
          value={overview.data?.last24h.pending ?? "—"}
          tone="info"
          loading={overview.isLoading}
        />
        <SummaryTile
          icon={Eye}
          label="Awaiting approval"
          value={overview.data?.last24h.reviewed ?? "—"}
          tone="warning"
          loading={overview.isLoading}
        />
        <SummaryTile
          icon={ShieldAlert}
          label="Suspicious (risk ≥ 80)"
          value={overview.data?.suspiciousCount ?? "—"}
          tone={
            (overview.data?.suspiciousCount ?? 0) > 0 ? "danger" : "success"
          }
          loading={overview.isLoading}
        />
        <SummaryTile
          icon={ShieldCheck}
          label="Pending dual approval"
          value={overview.data?.pendingDualApproval ?? "—"}
          tone={
            (overview.data?.pendingDualApproval ?? 0) > 0 ? "warning" : "success"
          }
          loading={overview.isLoading}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-fg-subtle" />
              <CardTitle>Payments</CardTitle>
              {highRiskOnly ? (
                <Badge className="bg-danger-subtle text-danger">
                  high-risk only
                </Badge>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={highRiskOnly ? "default" : "outline"}
                onClick={() => setHighRiskOnly((v) => !v)}
              >
                <Filter className="mr-1 h-3 w-3" />
                {highRiskOnly ? "Showing high-risk" : "High-risk only"}
              </Button>
              <div className="w-44">
                <Select
                  value={status}
                  onValueChange={(v) => setStatus(v as typeof status)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="reviewed">Reviewed</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="-mx-5 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-stroke/8 bg-surface-raised/40">
                  <TableHead>Submitted</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Txn ID</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={8}>
                        <div className="h-4 w-full animate-shimmer rounded" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : payments.length > 0 ? (
                  payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-xs text-fg-subtle">
                        {formatDateTime(p.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm font-medium text-fg">
                          {p.merchantName}
                        </div>
                        <div className="text-xs text-fg-subtle">
                          {p.merchantEmail}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm capitalize">
                        {p.plan}
                      </TableCell>
                      <TableCell>
                        {p.provider === "stripe" ? (
                          <Badge>
                            <CreditCard className="mr-1 h-3 w-3" /> Stripe
                          </Badge>
                        ) : (
                          <span className="capitalize text-sm">
                            {p.method.replace("_", " ")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {formatBDT(p.amount)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-fg-muted">
                        {p.txnId ?? "—"}
                      </TableCell>
                      <TableCell>
                        <RiskCell payment={p} />
                      </TableCell>
                      <TableCell className="text-right">
                        {p.status === "pending" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              markReviewed.mutate({ paymentId: p.id })
                            }
                            disabled={markReviewed.isPending}
                          >
                            <Eye className="mr-1 h-3 w-3" /> Mark reviewed
                          </Button>
                        ) : p.status === "reviewed" ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              className="bg-success text-white"
                              onClick={() => openApproveDialog(p)}
                            >
                              <CheckCircle2 className="mr-1 h-3 w-3" />
                              {p.requiresDualApproval && p.firstApprovalBy
                                ? "Second approval"
                                : "Approve"}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => openRejectDialog(p)}
                            >
                              <XCircle className="mr-1 h-3 w-3" /> Reject
                            </Button>
                          </div>
                        ) : (
                          <Badge
                            variant="outline"
                            className={
                              p.status === "approved"
                                ? "border-transparent bg-success-subtle text-success"
                                : "border-transparent bg-danger-subtle text-danger"
                            }
                          >
                            {p.status}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={8} className="p-0">
                      <EmptyState
                        icon={Inbox}
                        title={`No ${status} payments`}
                        description="Submissions will appear here when merchants pay."
                        className="m-4 border-0 bg-transparent"
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={!!stepupDialog.payment}
        onOpenChange={(v) =>
          !v &&
          !approve.isPending &&
          !reject.isPending &&
          setStepupDialog((s) => ({ ...s, payment: null, password: "" }))
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {stepupDialog.intent === "approve"
                ? "Confirm approval"
                : "Confirm rejection"}
            </DialogTitle>
            <DialogDescription>
              {stepupDialog.payment
                ? `${stepupDialog.payment.merchantName} — ${formatBDT(
                    stepupDialog.payment.amount,
                  )} for ${stepupDialog.payment.plan}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {stepupDialog.intent === "approve" ? (
            <div className="space-y-2">
              <Label>Billing period (days)</Label>
              <Input
                type="number"
                value={stepupDialog.days}
                onChange={(e) =>
                  setStepupDialog((s) => ({ ...s, days: e.target.value }))
                }
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Reason (shown to the merchant)</Label>
              <textarea
                className="min-h-[80px] w-full rounded-md border border-stroke/14 bg-surface-raised px-3 py-2 text-sm"
                value={stepupDialog.reason}
                onChange={(e) =>
                  setStepupDialog((s) => ({ ...s, reason: e.target.value }))
                }
              />
            </div>
          )}
          <div className="space-y-2">
            <Label>Re-enter your password</Label>
            <Input
              type="password"
              value={stepupDialog.password}
              autoComplete="current-password"
              onChange={(e) =>
                setStepupDialog((s) => ({ ...s, password: e.target.value }))
              }
            />
            <p className="text-xs text-fg-subtle">
              Step-up confirmation. Tokens are single-use, valid for 5 min,
              and bound to this action.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setStepupDialog((s) => ({ ...s, payment: null, password: "" }))
              }
            >
              Cancel
            </Button>
            <Button
              onClick={performStepupAction}
              disabled={
                approve.isPending || reject.isPending || issueStepup.isPending
              }
            >
              {approve.isPending ||
              reject.isPending ||
              issueStepup.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {stepupDialog.intent === "approve" ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type TileTone = "info" | "success" | "warning" | "danger";

const TILE_TONE: Record<TileTone, string> = {
  info: "bg-info-subtle text-info",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
};

function SummaryTile({
  icon: Icon,
  label,
  value,
  tone,
  loading,
}: {
  icon: typeof Inbox;
  label: string;
  value: number | string;
  tone: TileTone;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-lg ${TILE_TONE[tone]}`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-2xs uppercase tracking-wide text-fg-subtle">
            {label}
          </p>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums text-fg">
            {loading ? (
              <span className="inline-block h-6 w-12 animate-shimmer rounded" />
            ) : (
              value
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function RiskCell({ payment }: { payment: PendingPayment }) {
  const score = payment.riskScore ?? 0;
  const color =
    score >= 60
      ? "bg-danger-subtle text-danger"
      : score >= 30
        ? "bg-warning-subtle text-warning"
        : "bg-success-subtle text-success";
  return (
    <div className="space-y-1">
      <Badge className={`border-transparent ${color} font-mono`}>
        {score}
      </Badge>
      {payment.requiresDualApproval ? (
        <div className="flex items-center gap-1 text-xs text-danger">
          <ShieldAlert className="h-3 w-3" />
          {payment.firstApprovalBy ? "1/2 approvals" : "needs 2 admins"}
        </div>
      ) : null}
      {payment.riskReasons.length > 0 ? (
        <div className="flex flex-wrap gap-1 text-2xs">
          {payment.riskReasons.slice(0, 3).map((r) => (
            <span
              key={r}
              className="rounded bg-warning-subtle px-1 text-warning"
              title={r}
            >
              <AlertTriangle className="mr-0.5 inline h-2.5 w-2.5" />
              {r.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
