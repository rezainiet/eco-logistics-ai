"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, FileText, Info } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { humanizeError } from "@/lib/friendly-errors";

const SAMPLE_HEADER =
  "customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod";
const SAMPLE_TEMPLATE = `${SAMPLE_HEADER}
Rahim Ahmed,+8801712345678,House 12 Road 5 Banani,Dhaka,T-Shirt,1,500,500
Karim Mia,+8801812345670,House 4 Road 2 Sylhet,Sylhet,Mug,2,250,500`;

/**
 * Counts data rows in a CSV string, ignoring the header row and any
 * trailing blank lines. Used by the pre-flight count so merchants know
 * how many SMSes / orders are about to enter the system.
 */
export function countCsvDataRows(csv: string): number {
  const trimmed = csv.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return 0;
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

type Step = "pick" | "preview" | "confirm";
type UploadMode = "skip" | "replace" | "review";

interface UploadContext {
  uploadedAt: Date;
  source: string;
  externalBatchId: string;
}

/**
 * Per-dialog-open upload context. The `externalBatchId` is the
 * server-side anti-replay key — regenerated whenever the dialog opens
 * fresh OR the merchant clicks Reset, so an accidental re-submit of
 * the same csv in a new session always succeeds (as long as actual
 * duplicates pass the dedup check). Same dialog session keeps the
 * same id so a re-click of Confirm collides on the unique index.
 */
function makeUploadContext(): UploadContext {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    uploadedAt: new Date(),
    source: "manual_upload",
    externalBatchId: `web-${id}`,
  };
}

export function BulkUploadDialog({
  open,
  onOpenChange,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUploaded: () => void | Promise<void>;
}) {
  const [csv, setCsv] = useState<string>("");
  const [step, setStep] = useState<Step>("pick");
  const [mode, setMode] = useState<UploadMode>("skip");
  const [uploadContext, setUploadContext] = useState<UploadContext>(() =>
    makeUploadContext(),
  );
  const utils = trpc.useUtils();
  const upload = trpc.orders.bulkUpload.useMutation();

  // Mint a fresh batch id every time the dialog opens, so each session
  // is anti-replay-isolated from prior ones.
  useEffect(() => {
    if (open) setUploadContext(makeUploadContext());
  }, [open]);

  // Preview is fetched on demand (Review impact button) — not on every keystroke.
  const preview = trpc.orders.previewBulkUpload.useQuery(
    {
      csv,
      mode,
      uploadContext: {
        uploadedAt: uploadContext.uploadedAt,
        source: uploadContext.source,
        externalBatchId: uploadContext.externalBatchId,
      },
    },
    { enabled: false, retry: false },
  );

  const rowCount = useMemo(() => countCsvDataRows(csv), [csv]);

  // Whenever the merchant changes the CSV, drop any stale preview and
  // bounce them back to the pick step.
  useEffect(() => {
    if (step !== "pick") setStep("pick");
    upload.reset();
    preview.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csv]);

  function reset() {
    setCsv("");
    setStep("pick");
    setMode("skip");
    setUploadContext(makeUploadContext());
    upload.reset();
    preview.remove();
  }

  async function runPreview() {
    if (!csv.trim()) return;
    await preview.refetch();
    setStep("preview");
  }

  async function submit() {
    if (!csv.trim()) return;
    const res = await upload.mutateAsync({
      csv,
      mode,
      uploadContext: {
        uploadedAt: uploadContext.uploadedAt,
        source: uploadContext.source,
        externalBatchId: uploadContext.externalBatchId,
      },
    });
    // Always show the result panel — merchants need to see duplicates and
    // header warnings even on a fully-successful import. Review mode never
    // auto-closes (the merchant came here specifically to see the matches).
    setStep("confirm");
    if (
      res.mode !== "review" &&
      res.errors.length === 0 &&
      res.duplicates.length === 0
    ) {
      setTimeout(() => {
        reset();
        onOpenChange(false);
        void onUploaded();
      }, 1200);
    } else {
      void onUploaded();
    }
  }

  function downloadTemplate() {
    const blob = new Blob([SAMPLE_TEMPLATE], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "orders-template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const previewData = preview.data;
  const validRows = previewData?.validRows ?? 0;
  const errorRows = previewData?.errorRows ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {step === "preview"
              ? "Review the import"
              : step === "confirm"
                ? "Import result"
                : "Bulk upload orders"}
          </DialogTitle>
          <DialogDescription>
            {step === "preview"
              ? `${validRows} rows ready · ${errorRows} with errors. Review below before confirming.`
              : step === "confirm"
                ? "What just happened in your account."
                : "Upload a CSV. We'll show you a preview before anything is created."}
          </DialogDescription>
        </DialogHeader>

        {step === "pick" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="csv-file">CSV file</Label>
                <Button variant="ghost" size="sm" onClick={downloadTemplate}>
                  <Download className="mr-1 h-3 w-3" /> Template
                </Button>
              </div>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-primary-foreground hover:file:bg-primary/90"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setCsv(await f.text());
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="csv-text">Or paste CSV</Label>
              <textarea
                id="csv-text"
                className="h-32 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                placeholder={SAMPLE_HEADER}
              />
              <p className="text-2xs text-fg-muted">
                Common headers like <code>phone</code>, <code>address</code>,{" "}
                <code>city</code>, <code>totalAmount</code> are auto-mapped — you
                don't have to rename columns.
              </p>
            </div>
            {rowCount > 0 ? (
              <p className="flex items-center gap-1.5 text-2xs text-fg-muted">
                <FileText className="h-3 w-3" aria-hidden />
                Detected <strong className="text-fg">{rowCount}</strong> data
                row{rowCount === 1 ? "" : "s"} in the CSV.
              </p>
            ) : null}
            <div className="space-y-1.5">
              <Label>If a row already matches an existing order…</Label>
              <div className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    {
                      value: "skip",
                      title: "Skip duplicates",
                      blurb: "Default. Existing orders untouched; duplicate rows reported.",
                    },
                    {
                      value: "replace",
                      title: "Replace existing",
                      blurb:
                        "Cancel the matching pending/confirmed order and create the fresh row.",
                    },
                    {
                      value: "review",
                      title: "Review duplicates",
                      blurb: "Don't import anything — just show the matches.",
                    },
                  ] as const
                ).map((opt) => {
                  const active = mode === opt.value;
                  return (
                    <button
                      type="button"
                      key={opt.value}
                      onClick={() => setMode(opt.value)}
                      className={`rounded-md border p-2.5 text-left text-2xs transition-colors ${
                        active
                          ? "border-brand bg-brand-subtle text-fg"
                          : "border-border bg-surface text-fg-muted hover:border-stroke/24"
                      }`}
                      aria-pressed={active}
                    >
                      <p className="text-xs font-semibold text-fg">{opt.title}</p>
                      <p className="mt-0.5 leading-snug">{opt.blurb}</p>
                    </button>
                  );
                })}
              </div>
            </div>
            {preview.error && (
              <p className="text-sm text-destructive">
                {humanizeError(preview.error)}
              </p>
            )}
          </div>
        ) : step === "preview" ? (
          <div className="space-y-4">
            {previewData?.warnings?.duplicateBatch ? (
              <div className="rounded-md border border-danger-border bg-danger-subtle/30 p-3 text-xs text-danger">
                <p className="flex items-center gap-1 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5" /> This batch was already
                  uploaded
                </p>
                <p className="mt-0.5 opacity-90">
                  We've seen this exact batch id before. Click Cancel and reopen
                  the dialog to start a fresh batch.
                </p>
              </div>
            ) : null}
            {previewData?.warnings?.staleUpload ? (
              <div className="rounded-md border border-warning-border bg-warning-subtle/30 p-3 text-xs text-warning">
                <p className="flex items-center gap-1 font-semibold">
                  <Clock className="h-3.5 w-3.5" /> Stale upload
                </p>
                <p className="mt-0.5 opacity-90">
                  The upload timestamp is more than{" "}
                  {Math.floor(
                    (previewData.warnings.maxDriftMs ?? 7 * 86400_000) / 86400_000,
                  )}{" "}
                  days old. Refresh the page before submitting — submitting will
                  be rejected by the server.
                </p>
              </div>
            ) : null}
            {mode === "replace" && (previewData?.wouldReplace ?? 0) > 0 ? (
              <div className="rounded-md border border-warning-border bg-warning-subtle p-3 text-xs text-warning">
                <p className="flex items-center gap-1 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5" /> You are about to
                  re-create {previewData?.wouldReplace ?? 0} existing order
                  {previewData?.wouldReplace === 1 ? "" : "s"}
                </p>
                <p className="mt-0.5 opacity-90">
                  Replace mode will cancel{" "}
                  {previewData?.wouldReplace ?? 0} pending/confirmed order
                  {previewData?.wouldReplace === 1 ? "" : "s"} and insert the
                  CSV row{previewData?.wouldReplace === 1 ? "" : "s"} in their
                  place. Cancelled orders release their quota — but if any of
                  them already shipped, this won't touch them.
                </p>
              </div>
            ) : null}
            {(previewData?.nonReplaceableCount ?? 0) > 0 ? (
              <div className="rounded-md border border-info/30 bg-info/8 p-3 text-xs text-info">
                <p className="flex items-center gap-1 font-semibold">
                  <Info className="h-3.5 w-3.5" />{" "}
                  {previewData?.nonReplaceableCount ?? 0} duplicate
                  {previewData?.nonReplaceableCount === 1 ? "" : "s"} can't be
                  replaced
                </p>
                <p className="mt-0.5 opacity-90">
                  These match orders that already shipped, were delivered, or
                  RTO'd. They'll be skipped regardless of mode.
                </p>
              </div>
            ) : null}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border bg-success-subtle/40 p-2">
                <p className="text-xl font-semibold text-success">
                  {previewData?.wouldInsert ?? validRows}
                </p>
                <p className="text-2xs text-fg-muted">
                  {mode === "review" ? "would insert" : "ready to import"}
                </p>
              </div>
              <div className="rounded-md border bg-warning-subtle/40 p-2">
                <p className="text-xl font-semibold text-warning">
                  {mode === "replace"
                    ? previewData?.wouldReplace ?? 0
                    : previewData?.wouldSkip ?? previewData?.duplicates?.length ?? 0}
                </p>
                <p className="text-2xs text-fg-muted">
                  {mode === "replace" ? "to replace" : "duplicates skipped"}
                </p>
              </div>
              <div className="rounded-md border bg-danger-subtle/40 p-2">
                <p className="text-xl font-semibold text-danger">{errorRows}</p>
                <p className="text-2xs text-fg-muted">row errors</p>
              </div>
            </div>

            {previewData?.headerWarnings && previewData.headerWarnings.length > 0 ? (
              <div className="rounded-md border border-warning-border bg-warning-subtle/30 p-3 text-xs text-warning">
                <p className="mb-1 flex items-center gap-1 font-medium">
                  <Info className="h-3 w-3" /> Column auto-mapping
                </p>
                <ul className="space-y-0.5">
                  {previewData.headerWarnings.map((w, i) => (
                    <li key={i}>
                      <code>{w.original}</code> → <code>{w.mappedTo}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {previewData?.unknownColumns && previewData.unknownColumns.length > 0 ? (
              <div className="rounded-md border bg-muted/40 p-3 text-xs text-fg-muted">
                Ignored columns: {previewData.unknownColumns.map((c) => `"${c}"`).join(", ")}
              </div>
            ) : null}

            {previewData?.preview && previewData.preview.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-fg">First {previewData.preview.length} rows</p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-2xs">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-2 py-1 text-left">Row</th>
                        <th className="px-2 py-1 text-left">Customer</th>
                        <th className="px-2 py-1 text-left">Phone</th>
                        <th className="px-2 py-1 text-left">District</th>
                        <th className="px-2 py-1 text-right">COD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewData.preview.map((p) => (
                        <tr key={p.rowNumber} className="border-t">
                          <td className="px-2 py-1">{p.rowNumber}</td>
                          <td className="px-2 py-1">{p.customer.name}</td>
                          <td className="px-2 py-1 font-mono">{p.customer.phone}</td>
                          <td className="px-2 py-1">{p.customer.district}</td>
                          <td className="px-2 py-1 text-right">৳{p.cod}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {previewData?.errors && previewData.errors.length > 0 ? (
              <div className="rounded-md border border-danger-border bg-danger-subtle/30 p-3 text-xs">
                <p className="mb-1 flex items-center gap-1 font-medium text-danger">
                  <AlertTriangle className="h-3 w-3" /> Row errors
                </p>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto text-danger">
                  {previewData.errors.slice(0, 25).map((e, i) => (
                    <li key={i}>
                      Row {e.row}: {e.error}
                    </li>
                  ))}
                  {previewData.errors.length > 25 && (
                    <li className="opacity-80">
                      …and {previewData.errors.length - 25} more
                    </li>
                  )}
                </ul>
              </div>
            ) : null}

            {validRows >= 20 ? (
              <div className="rounded-lg border border-warning-border bg-warning-subtle p-3 text-xs text-warning">
                <div className="flex items-start gap-2">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <div>
                    <p className="font-semibold">
                      This will send approximately {validRows} confirmation SMS
                    </p>
                    <p className="opacity-90">
                      Make sure you have enough SMS balance with your provider
                      before confirming.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          // step === "confirm" → result panel
          <div className="space-y-3">
            {upload.data ? (
              <>
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  {upload.data.mode === "review" ? (
                    <p className="flex items-center gap-1 font-medium text-info">
                      <Info className="h-4 w-4" />
                      Review-only: no orders were created.{" "}
                      {upload.data.duplicates.length} match
                      {upload.data.duplicates.length === 1 ? "" : "es"} found.
                    </p>
                  ) : (
                    <p className="flex items-center gap-1 font-medium text-success">
                      <CheckCircle2 className="h-4 w-4" />
                      Inserted <strong>{upload.data.inserted}</strong> orders
                      {upload.data.replaced > 0 ? (
                        <span className="ml-1 text-warning">
                          (replaced {upload.data.replaced})
                        </span>
                      ) : null}
                      {upload.data.flagged > 0 ? (
                        <span className="ml-1 text-warning">
                          ({upload.data.flagged} flagged for fraud review)
                        </span>
                      ) : null}
                    </p>
                  )}
                </div>
                {upload.data.duplicates.length > 0 ? (
                  <div className="rounded-md border border-warning-border bg-warning-subtle/30 p-3 text-xs text-warning">
                    {upload.data.mode === "replace"
                      ? `Skipped ${upload.data.duplicates.length - upload.data.replaced} non-replaceable duplicate(s) — these matched orders that already shipped or finalised.`
                      : `Skipped ${upload.data.duplicates.length} duplicate row${upload.data.duplicates.length === 1 ? "" : "s"} (matching phone + COD + items + same day).`}
                  </div>
                ) : null}
                {upload.data.errors.length > 0 ? (
                  <div className="rounded-md border border-danger-border bg-danger-subtle/30 p-3 text-xs text-danger">
                    {upload.data.errors.length} row
                    {upload.data.errors.length === 1 ? "" : "s"} skipped due to
                    errors. Fix the CSV and re-upload.
                  </div>
                ) : null}
              </>
            ) : null}
            {upload.error && (
              <p className="text-sm text-destructive">
                {humanizeError(upload.error)}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "pick" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={runPreview}
                disabled={!csv.trim() || preview.isFetching}
              >
                {preview.isFetching ? "Validating…" : "Preview"}
              </Button>
            </>
          ) : step === "preview" ? (
            <>
              <Button variant="outline" onClick={() => setStep("pick")}>
                Back
              </Button>
              <Button
                onClick={submit}
                disabled={
                  upload.isLoading ||
                  Boolean(previewData?.warnings?.duplicateBatch) ||
                  Boolean(previewData?.warnings?.staleUpload) ||
                  (mode === "review"
                    ? false
                    : (previewData?.wouldInsert ?? 0) === 0)
                }
              >
                {upload.isLoading
                  ? mode === "replace"
                    ? "Replacing & importing…"
                    : "Importing…"
                  : mode === "review"
                    ? "Run review (no changes)"
                    : mode === "replace"
                      ? `Replace ${previewData?.wouldReplace ?? 0} & import ${previewData?.wouldInsert ?? 0}`
                      : `Confirm import of ${previewData?.wouldInsert ?? validRows} order${(previewData?.wouldInsert ?? validRows) === 1 ? "" : "s"}`}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
