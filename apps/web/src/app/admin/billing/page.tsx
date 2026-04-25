"use client";

import { useState } from "react";
import {
  CheckCircle2,
  CreditCard,
  Download,
  ExternalLink,
  FileImage,
  Inbox,
  Loader2,
  XCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
  status: "pending" | "approved" | "rejected";
};

type ApproveState = { open: boolean; payment: PendingPayment | null; days: string };
type RejectState = { open: boolean; payment: PendingPayment | null; reason: string };

export default function AdminBillingPage() {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [extendForm, setExtendForm] = useState({ merchantId: "", days: "30", note: "" });
  const [changeForm, setChangeForm] = useState({
    merchantId: "",
    tier: "growth" as "starter" | "growth" | "scale" | "enterprise",
    note: "",
  });
  const [approveState, setApproveState] = useState<ApproveState>({
    open: false,
    payment: null,
    days: "30",
  });
  const [rejectState, setRejectState] = useState<RejectState>({
    open: false,
    payment: null,
    reason: "",
  });
  const [viewingProofId, setViewingProofId] = useState<string | null>(null);

  const list = trpc.adminBilling.listPendingPayments.useQuery({ status, limit: 100 });
  const utils = trpc.useUtils();

  const approve = trpc.adminBilling.approvePayment.useMutation({
    onSuccess: () => {
      toast.success("Approved", "Subscription activated.");
      setApproveState({ open: false, payment: null, days: "30" });
      utils.adminBilling.listPendingPayments.invalidate();
    },
    onError: (err) => toast.error("Approval failed", err.message),
  });
  const reject = trpc.adminBilling.rejectPayment.useMutation({
    onSuccess: () => {
      toast.success("Rejected");
      setRejectState({ open: false, payment: null, reason: "" });
      utils.adminBilling.listPendingPayments.invalidate();
    },
    onError: (err) => toast.error("Rejection failed", err.message),
  });
  const extend = trpc.adminBilling.extendSubscription.useMutation({
    onSuccess: (res) =>
      toast.success("Extended", `New period end: ${formatDateTime(res.currentPeriodEnd)}`),
    onError: (err) => toast.error("Extend failed", err.message),
  });
  const change = trpc.adminBilling.changePlan.useMutation({
    onSuccess: (res) => toast.success("Plan changed", `Merchant now on ${res.tier}`),
    onError: (err) => toast.error("Change failed", err.message),
  });

  const payments = (list.data ?? []) as PendingPayment[];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Billing approvals"
        description="Approve or reject manual payment submissions and manage merchant subscriptions."
      />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-fg-subtle" />
              <CardTitle>Payments</CardTitle>
            </div>
            <div className="w-40">
              <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="-mx-5 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-stroke/8 bg-surface-raised/40">
                  <TableHead className="h-11 px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                    Submitted
                  </TableHead>
                  <TableHead className="h-11 px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                    Merchant
                  </TableHead>
                  <TableHead className="h-11 px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                    Plan
                  </TableHead>
                  <TableHead className="h-11 px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                    Method
                  </TableHead>
                  <TableHead className="h-11 px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                    Amount
                  </TableHead>
                  <TableHead className="h-11 px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                    Txn ID
                  </TableHead>
                  <TableHead className="h-11 px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                    Proof
                  </TableHead>
                  <TableHead className="h-11 px-3 text-right text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i} className="border-stroke/6">
                      <TableCell colSpan={8} className="py-3">
                        <div className="h-4 w-full animate-shimmer rounded" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : payments.length > 0 ? (
                  payments.map((p) => (
                    <TableRow key={p.id} className="border-stroke/6 hover:bg-surface-raised/40">
                      <TableCell className="px-3 py-3 text-xs text-fg-subtle">
                        {formatDateTime(p.createdAt)}
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <div className="text-sm font-medium text-fg">{p.merchantName}</div>
                        <div className="text-xs text-fg-subtle">{p.merchantEmail}</div>
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <div className="capitalize text-sm text-fg">{p.plan}</div>
                        <div className="text-xs text-fg-subtle">current: {p.currentTier}</div>
                      </TableCell>
                      <TableCell className="px-3 py-3 text-sm text-fg-muted">
                        {p.provider === "stripe" ? (
                          <Badge className="border-transparent bg-info-subtle text-info">
                            <CreditCard className="mr-1 h-3 w-3" /> Stripe
                          </Badge>
                        ) : (
                          <span className="capitalize">{p.method.replace("_", " ")}</span>
                        )}
                      </TableCell>
                      <TableCell className="px-3 py-3 font-mono text-sm tabular-nums text-fg">
                        {formatBDT(p.amount)}
                      </TableCell>
                      <TableCell className="px-3 py-3 font-mono text-xs text-fg-muted">
                        {p.txnId ?? "—"}
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        {p.hasProofFile ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => setViewingProofId(p.id)}
                          >
                            <FileImage className="mr-1 h-3 w-3" /> Preview
                          </Button>
                        ) : p.proofUrl ? (
                          <a
                            href={p.proofUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                          >
                            View <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-fg-faint">—</span>
                        )}
                      </TableCell>
                      <TableCell className="px-3 py-3 text-right">
                        {p.status === "pending" ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              className="bg-success text-white hover:bg-success/90"
                              onClick={() =>
                                setApproveState({ open: true, payment: p, days: "30" })
                              }
                              disabled={approve.isPending}
                            >
                              <CheckCircle2 className="mr-1 h-3 w-3" /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() =>
                                setRejectState({ open: true, payment: p, reason: "" })
                              }
                              disabled={reject.isPending}
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
                        description={
                          status === "pending"
                            ? "New manual payment submissions will appear here for review."
                            : `Switch the filter to see other payment states.`
                        }
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

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Extend subscription</CardTitle>
            <CardDescription>
              Push a merchant's currentPeriodEnd forward by N days (comp extension).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>Merchant ID</Label>
              <Input
                value={extendForm.merchantId}
                onChange={(e) => setExtendForm((f) => ({ ...f, merchantId: e.target.value }))}
                placeholder="ObjectId"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Days</Label>
              <Input
                type="number"
                value={extendForm.days}
                onChange={(e) => setExtendForm((f) => ({ ...f, days: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Note</Label>
              <Input
                value={extendForm.note}
                onChange={(e) => setExtendForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>
            <Button
              className="bg-brand text-white hover:bg-brand-hover"
              onClick={() => {
                const days = Number(extendForm.days);
                if (!extendForm.merchantId || !Number.isFinite(days) || days <= 0) {
                  toast.error("Provide a merchant id and positive days");
                  return;
                }
                extend.mutate({
                  merchantId: extendForm.merchantId,
                  days,
                  note: extendForm.note || undefined,
                });
              }}
              disabled={extend.isPending}
            >
              {extend.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Extend
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change plan</CardTitle>
            <CardDescription>
              Force a merchant onto a different plan without creating a payment record.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>Merchant ID</Label>
              <Input
                value={changeForm.merchantId}
                onChange={(e) => setChangeForm((f) => ({ ...f, merchantId: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Tier</Label>
              <Select
                value={changeForm.tier}
                onValueChange={(v) => setChangeForm((f) => ({ ...f, tier: v as typeof f.tier }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="growth">Growth</SelectItem>
                  <SelectItem value="scale">Scale</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Note</Label>
              <Input
                value={changeForm.note}
                onChange={(e) => setChangeForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>
            <Button
              className="bg-brand text-white hover:bg-brand-hover"
              onClick={() => {
                if (!changeForm.merchantId) {
                  toast.error("Provide a merchant id");
                  return;
                }
                change.mutate({
                  merchantId: changeForm.merchantId,
                  tier: changeForm.tier,
                  note: changeForm.note || undefined,
                });
              }}
              disabled={change.isPending}
            >
              {change.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Change plan
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Approve payment dialog */}
      <Dialog
        open={approveState.open}
        onOpenChange={(v) => {
          if (!v && !approve.isPending) {
            setApproveState({ open: false, payment: null, days: "30" });
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve payment</DialogTitle>
            <DialogDescription>
              {approveState.payment
                ? `${approveState.payment.merchantName} — ${formatBDT(
                    approveState.payment.amount,
                  )} for ${approveState.payment.plan}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="approve-days">Billing period length (days)</Label>
            <Input
              id="approve-days"
              type="number"
              min={1}
              value={approveState.days}
              onChange={(e) =>
                setApproveState((s) => ({ ...s, days: e.target.value }))
              }
            />
            <p className="text-xs text-fg-subtle">
              Subscription will be activated and currentPeriodEnd set to{" "}
              <span className="font-medium text-fg">today + days</span>.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-stroke/14 bg-transparent text-fg hover:bg-surface-raised"
              onClick={() =>
                setApproveState({ open: false, payment: null, days: "30" })
              }
              disabled={approve.isPending}
            >
              Cancel
            </Button>
            <Button
              className="bg-success text-white hover:bg-success/90"
              onClick={() => {
                const days = Number(approveState.days);
                if (!approveState.payment || !Number.isFinite(days) || days <= 0) {
                  toast.error("Enter a positive number of days");
                  return;
                }
                approve.mutate({
                  paymentId: approveState.payment.id,
                  periodDays: days,
                });
              }}
              disabled={approve.isPending}
            >
              {approve.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              Approve &amp; activate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject payment dialog */}
      <Dialog
        open={rejectState.open}
        onOpenChange={(v) => {
          if (!v && !reject.isPending) {
            setRejectState({ open: false, payment: null, reason: "" });
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject payment</DialogTitle>
            <DialogDescription>
              {rejectState.payment
                ? `${rejectState.payment.merchantName} — ${formatBDT(
                    rejectState.payment.amount,
                  )}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Reason (shown to the merchant)</Label>
            <textarea
              id="reject-reason"
              className="flex min-h-[84px] w-full rounded-md border border-stroke/14 bg-surface-raised px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              placeholder="e.g., Transaction ID doesn't match our bank records."
              value={rejectState.reason}
              onChange={(e) => setRejectState((s) => ({ ...s, reason: e.target.value }))}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-stroke/14 bg-transparent text-fg hover:bg-surface-raised"
              onClick={() =>
                setRejectState({ open: false, payment: null, reason: "" })
              }
              disabled={reject.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!rejectState.payment) return;
                const trimmed = rejectState.reason.trim();
                if (!trimmed) {
                  toast.error("Enter a rejection reason");
                  return;
                }
                reject.mutate({
                  paymentId: rejectState.payment.id,
                  reason: trimmed,
                });
              }}
              disabled={reject.isPending}
            >
              {reject.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <XCircle className="mr-2 h-4 w-4" />
              )}
              Reject payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AdminProofDialog
        paymentId={viewingProofId}
        onClose={() => setViewingProofId(null)}
      />
    </div>
  );
}

function AdminProofDialog({
  paymentId,
  onClose,
}: {
  paymentId: string | null;
  onClose: () => void;
}) {
  const open = paymentId !== null;
  const proof = trpc.billing.getPaymentProof.useQuery(
    { paymentId: paymentId ?? "" },
    { enabled: open, retry: false },
  );
  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Payment proof</DialogTitle>
        </DialogHeader>
        {proof.isLoading ? (
          <div className="flex items-center justify-center py-10 text-fg-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : proof.error ? (
          <p className="py-6 text-center text-sm text-fg-faint">
            {proof.error.message ?? "No proof on file."}
          </p>
        ) : proof.data?.dataUrl ? (
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <p className="text-fg-faint">
                {proof.data.contentType ?? "external link"}
                {proof.data.sizeBytes
                  ? ` · ${Math.round(proof.data.sizeBytes / 1024)} KB`
                  : ""}
              </p>
              <a
                href={proof.data.dataUrl}
                target="_blank"
                rel="noreferrer"
                download={proof.data.filename ?? undefined}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-stroke/14 px-2.5 text-2xs text-fg hover:bg-surface-raised"
              >
                <Download className="h-3 w-3" />
                {proof.data.kind === "url" ? "Open" : "Download"}
              </a>
            </div>
            {proof.data.contentType === "application/pdf" ? (
              <iframe
                src={proof.data.dataUrl}
                className="h-[480px] w-full rounded-md border border-stroke/12"
                title="Payment proof"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={proof.data.dataUrl}
                alt="Payment proof"
                className="max-h-[480px] w-full rounded-md border border-stroke/12 object-contain"
              />
            )}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-fg-faint">No proof on file.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
