"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Globe, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

/**
 * Page settings → Custom domain (one per page). The merchant adds a domain,
 * copies the DNS records, clicks "Check DNS"; once ownership is proven and
 * the domain points to ConfirmX, the server issues the HTTPS certificate
 * and the page goes live on it. The subdomain keeps working throughout.
 */

type Status = "pending_verification" | "verified" | "ssl_pending" | "live" | "error";

const STATUS: Record<Status, { label: string; variant: "secondary" | "warning" | "info" | "success" | "destructive"; help: string }> = {
  pending_verification: { label: "Verification required", variant: "warning", help: "Add the TXT record below at your DNS provider, then check again." },
  verified: { label: "Verified", variant: "info", help: "You own this domain. Point it to ConfirmX with the record below, then check again." },
  ssl_pending: { label: "SSL pending", variant: "info", help: "Setting up the secure certificate — usually a few minutes. This page updates by itself." },
  live: { label: "Active", variant: "success", help: "Your page is live on this domain." },
  error: { label: "Error", variant: "destructive", help: "Something needs attention — see below, fix it, then check again." },
};

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1 rounded bg-surface-raised px-1.5 py-0.5 text-left font-mono text-2xs text-fg hover:bg-surface-overlay"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={`Copy ${value}`}
    >
      <span className="break-all">{value}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-success" /> : <Copy className="h-3 w-3 shrink-0 text-fg-subtle" />}
    </button>
  );
}

export function DomainSettings({ pageId, disabled, className }: { pageId: string; disabled?: boolean; className?: string }) {
  const utils = trpc.useUtils();
  const query = trpc.landingPages.domains.useQuery(
    { id: pageId },
    {
      refetchOnWindowFocus: false,
      // While the server is issuing the certificate, poll so "Active" shows up by itself.
      refetchInterval: (data) => ((data?.domains ?? []).some((d) => d.status === "ssl_pending") ? 20_000 : false),
    },
  );
  const refresh = () => utils.landingPages.domains.invalidate({ id: pageId });
  const [hostname, setHostname] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const add = trpc.landingPages.addDomain.useMutation({
    onSuccess: () => {
      setHostname("");
      setNote(null);
      void refresh();
    },
    onError: (e) => toast.error("Domain not added", e.message),
  });
  const check = trpc.landingPages.checkDomain.useMutation({
    onSuccess: (r) => {
      setNote(r.message);
      void refresh();
    },
    onError: (e) => toast.error("Check failed", e.message),
  });
  const remove = trpc.landingPages.removeDomain.useMutation({
    onSuccess: () => {
      setConfirmRemove(false);
      setNote(null);
      toast.success("Domain removed", "Your page stays available on its subdomain.");
      void refresh();
    },
    onError: (e) => toast.error("Domain not removed", e.message),
  });

  const data = query.data;
  const domain = data?.domains[0];
  const status = domain ? STATUS[domain.status as Status] : null;
  // After a failed certificate attempt, retries wait (Let's Encrypt limits).
  const retryAt = domain?.status === "error" && domain.sslRetryAt ? new Date(domain.sslRetryAt as unknown as string) : null;
  const waiting = !!retryAt && retryAt.getTime() > Date.now();

  return (
    <div className={cn("space-y-3 rounded-lg border border-stroke/10 bg-surface p-4", className)} id="domain">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <Globe className="h-4 w-4" /> Custom domain
        </div>
        {query.isLoading ? null : status ? <Badge variant={status.variant}>{status.label}</Badge> : <Badge variant="secondary">Not added</Badge>}
      </div>

      {query.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : query.isError ? (
        <p className="text-xs text-danger">Could not load the domain: {query.error.message}</p>
      ) : !data?.enabled ? (
        <p className="text-xs text-fg-subtle">Connecting your own domain (like shop.yourbrand.com) is coming soon. Your page is available on its ConfirmX subdomain.</p>
      ) : !domain ? (
        <>
          <p className="text-xs text-fg-subtle">Show this page on a domain you own, like shop.yourbrand.com. You&apos;ll need access to its DNS settings.</p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (hostname.trim()) add.mutate({ id: pageId, hostname: hostname.trim() });
            }}
          >
            <Input
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="shop.yourbrand.com"
              maxLength={253}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-label="Your domain"
              disabled={disabled}
            />
            <Button type="submit" size="sm" className="h-10" disabled={disabled || !hostname.trim() || add.isLoading}>
              {add.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
            </Button>
          </form>
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all font-mono text-sm text-fg">{domain.hostname}</span>
            {domain.url ? (
              <a href={domain.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
                Open <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
          <p className="text-xs text-fg-subtle">{status?.help}</p>
          {(note ?? domain.lastError) && domain.status !== "live" ? (
            <p className={cn("rounded-md px-3 py-2 text-xs", domain.status === "error" ? "bg-danger-subtle text-danger" : "bg-warning-subtle text-warning")}>{note ?? domain.lastError}</p>
          ) : domain.status === "live" && domain.lastError ? (
            <p className="rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning">{domain.lastError}</p>
          ) : null}

          {domain.status !== "live" && domain.status !== "ssl_pending" ? (
            <div className="overflow-x-auto rounded-md border border-stroke/10">
              <table className="w-full text-xs">
                <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Type</th>
                    <th className="px-2 py-1.5 font-medium">Name / Host</th>
                    <th className="px-2 py-1.5 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stroke/8">
                  {domain.records
                    .filter((r) => (domain.status === "pending_verification" ? true : r.purpose === "routing"))
                    .map((r) => (
                      <tr key={`${r.type}:${r.name}:${r.value}`} className="align-top">
                        <td className="px-2 py-1.5 font-mono text-fg">{r.type}</td>
                        <td className="px-2 py-1.5">
                          <CopyValue value={r.name} />
                        </td>
                        <td className="px-2 py-1.5">
                          <CopyValue value={r.value} />
                          {r.note ? <p className="mt-1 text-2xs text-fg-faint">{r.note}</p> : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!domain.routingConfigured ? <p className="px-2 py-1.5 text-2xs text-fg-faint">The routing record will appear here once ConfirmX enables it.</p> : null}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {domain.status !== "live" && domain.status !== "ssl_pending" ? (
              <Button size="sm" variant="outline" disabled={disabled || check.isLoading || waiting} onClick={() => check.mutate({ domainId: domain.id })}>
                {check.isLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />} Check DNS
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" className="text-danger" disabled={remove.isLoading} onClick={() => setConfirmRemove(true)}>
              <Trash2 className="mr-1 h-4 w-4" /> Remove
            </Button>
          </div>
          {waiting ? (
            <p className="text-2xs text-fg-subtle">
              You can retry after {retryAt!.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — repeated attempts are spaced out so the certificate authority doesn&apos;t block the domain.
            </p>
          ) : null}
          <p className="text-2xs text-fg-faint">DNS changes can take a few minutes to a few hours to be visible everywhere.</p>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove this domain?"
        description={
          <>
            <span className="font-mono">{domain?.hostname}</span> will stop showing this page. Your page stays available on its ConfirmX subdomain. To use the domain again you&apos;ll need to verify it again.
          </>
        }
        confirmLabel="Remove domain"
        destructive
        loading={remove.isLoading}
        onConfirm={() => domain && remove.mutate({ domainId: domain.id })}
      />
    </div>
  );
}
