"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

const SAMPLE_HEADER =
  "orderNumber,customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod";

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
  const upload = trpc.orders.bulkUpload.useMutation();

  async function onFile(file: File) {
    setCsv(await file.text());
  }

  async function submit() {
    if (!csv.trim()) return;
    const res = await upload.mutateAsync({ csv });
    if (res.errors.length === 0) {
      setCsv("");
      onOpenChange(false);
      await onUploaded();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          upload.reset();
          setCsv("");
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk upload orders</DialogTitle>
          <DialogDescription>
            Upload a CSV with columns: <code className="text-xs">{SAMPLE_HEADER}</code>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="csv-file">CSV file</Label>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-primary-foreground hover:file:bg-primary/90"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
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
          </div>
          {upload.data && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p>
                Inserted <strong>{upload.data.inserted}</strong> orders.
              </p>
              {upload.data.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-destructive">
                  {upload.data.errors.slice(0, 10).map((e, i) => (
                    <li key={i}>
                      Row {e.row}: {e.error}
                    </li>
                  ))}
                  {upload.data.errors.length > 10 && <li>…and {upload.data.errors.length - 10} more</li>}
                </ul>
              )}
            </div>
          )}
          {upload.error && <p className="text-sm text-destructive">{upload.error.message}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!csv.trim() || upload.isLoading}>
            {upload.isLoading ? "Uploading…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
