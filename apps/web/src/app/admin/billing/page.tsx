"use client";

import { useState } from "react";
import { CheckCircle2, ExternalLink, Inbox, XCircle } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function formatBDT(n: number): string {
  return `৳ ${n.toLocaleString()}`;
}
function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminBillingPage() {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [extendForm, setExtendForm] = useState({ merchantId: "", days: "30", note: "" });
  const [changeForm, setChangeForm] = useState({
    merchantId: "",
    tier: "growth" as "starter" | "growth" | "scale" | "enterprise",
    note: "",
  });

  const list = trpc.adminBilling.listPendingPayments.useQuery({ status, limit: 100 });
  const utils = trpc.useUtils();

  const approve = trpc.adminBilling.approvePayment.useMutation({
    onSuccess: () => {
      toast.success("Approved", "Subscription activated.");
      utils.adminBilling.listPendingPayments.invalidate();
    },
    onError: (err) => toast.error("Approval failed", err.message),
  });
  const reject = trpc.adminBilling.rejectPayment.useMutation({
    onSuccess: () => {
      toast.success("Rejected");
      utils.adminBilling.listPendingPayments.invalidate();
    },
    onError: (err) => toast.error("Rejection failed", err.message),
  });
  const extend = trpc.adminBilling.extendSubscription.useMutation({
    onSuccess: (res) => toast.success("Extended", `New period end: ${formatDate(res.currentPeriodEnd)}`),
    onError: (err) => toast.error("Extend failed", err.message),
  });
  const change = trpc.adminBilling.changePlan.useMutation({
    onSuccess: (res) => toast.success("Plan changed", `Merchant now on ${res.tier}`),
    onError: (err) => toast.error("Change failed", err.message),
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-[#F3F4F6]">Billing approvals</h1>
        <p className="text-sm text-[#9CA3AF]">
          Approve or reject manual payment submissions and manage merchant subscriptions.
        </p>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-[#9CA3AF]" />
              <CardTitle className="text-base">Payments</CardTitle>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Submitted</TableHead>
                <TableHead>Merchant</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Txn ID</TableHead>
                <TableHead>Proof</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data?.length ? (
                list.data.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-xs text-[#9CA3AF]">{formatDate(p.createdAt)}</TableCell>
                    <TableCell>
                      <div className="text-sm text-[#F3F4F6]">{p.merchantName}</div>
                      <div className="text-xs text-[#9CA3AF]">{p.merchantEmail}</div>
                    </TableCell>
                    <TableCell>
                      <div className="capitalize">{p.plan}</div>
                      <div className="text-xs text-[#9CA3AF]">current: {p.currentTier}</div>
                    </TableCell>
                    <TableCell className="capitalize">{p.method.replace("_", " ")}</TableCell>
                    <TableCell>{formatBDT(p.amount)}</TableCell>
                    <TableCell className="font-mono text-xs">{p.txnId ?? "—"}</TableCell>
                    <TableCell>
                      {p.proofUrl ? (
                        <a
                          href={p.proofUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-[#0084D4] hover:underline"
                        >
                          View <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-[#6B7280]">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {p.status === "pending" ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            onClick={() => {
                              const days = Number(prompt("Period length in days?", "30") ?? "30");
                              if (!Number.isFinite(days) || days <= 0) return;
                              approve.mutate({ paymentId: p.id, periodDays: days });
                            }}
                            disabled={approve.isPending}
                          >
                            <CheckCircle2 className="mr-1 h-3 w-3" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              const reason = prompt("Reason for rejection?");
                              if (!reason) return;
                              reject.mutate({ paymentId: p.id, reason });
                            }}
                            disabled={reject.isPending}
                          >
                            <XCircle className="mr-1 h-3 w-3" /> Reject
                          </Button>
                        </div>
                      ) : (
                        <Badge
                          className={
                            p.status === "approved"
                              ? "bg-[rgba(16,185,129,0.15)] text-[#34D399]"
                              : "bg-[rgba(239,68,68,0.15)] text-[#F87171]"
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
                  <TableCell colSpan={8} className="text-center text-xs text-[#6B7280]">
                    No {status} payments
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Extend subscription</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
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
              Extend
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Change plan</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
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
              Change plan
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
