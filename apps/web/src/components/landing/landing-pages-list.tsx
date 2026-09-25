"use client";

import { useState } from "react";
import Link from "next/link";
import { Archive, Copy, ExternalLink, LayoutTemplate, Loader2, Pencil, Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LandingStatusBadge } from "./status-badge";

export function LandingPagesList() {
  const utils = trpc.useUtils();
  const [showArchived, setShowArchived] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const list = trpc.landingPages.list.useQuery({ includeArchived: showArchived });
  const duplicate = trpc.landingPages.duplicate.useMutation({
    onSuccess: () => {
      toast.success("Page duplicated", "The copy is a draft without a subdomain.");
      void utils.landingPages.list.invalidate();
    },
    onError: (e) => toast.error("Could not duplicate", e.message),
  });
  const archive = trpc.landingPages.archive.useMutation({
    onSuccess: () => {
      toast.success("Page archived");
      void utils.landingPages.list.invalidate();
    },
    onError: (e) => toast.error("Could not archive", e.message),
  });

  const pages = list.data ?? [];
  const target = pages.find((p) => p.id === archiveId);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Connect"
        title="Landing pages"
        description="Build pages from ready-made templates. Edit the content, preview, and publish when you're ready — drafts never affect your live page."
        actions={
          <Button asChild>
            <Link href="/dashboard/landing-pages/new">
              <Plus className="mr-1.5 h-4 w-4" /> Create landing page
            </Link>
          </Button>
        }
      />

      {list.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-subtle">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : pages.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title="No landing pages yet"
          description="Pick a template to create your first page."
          action={
            <Button asChild>
              <Link href="/dashboard/landing-pages/new">Choose a template</Link>
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-stroke/10 bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Page</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Template</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="hidden px-4 py-3 font-medium lg:table-cell">Subdomain</th>
                <th className="hidden px-4 py-3 font-medium lg:table-cell">Updated</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke/8">
              {pages.map((p) => (
                <tr key={p.id} className="hover:bg-surface-raised/40">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/landing-pages/${p.id}`} className="font-medium text-fg hover:underline">
                      {p.name}
                    </Link>
                    {p.hasUnpublishedChanges ? <p className="text-2xs text-warning">Unpublished changes</p> : null}
                  </td>
                  <td className="hidden px-4 py-3 text-fg-muted md:table-cell">{p.templateName}</td>
                  <td className="px-4 py-3">
                    <LandingStatusBadge status={p.status} />
                  </td>
                  <td className="hidden px-4 py-3 font-mono text-xs text-fg-muted lg:table-cell">
                    {p.publicUrl ? (
                      <a href={p.publicUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                        {p.slug} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      p.slug ?? "—"
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-fg-subtle lg:table-cell">
                    {new Date(p.updatedAt as unknown as string).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {p.status !== "archived" ? (
                        <>
                          <Button asChild size="icon" variant="ghost" className="h-8 w-8" aria-label="Edit">
                            <Link href={`/dashboard/landing-pages/${p.id}`}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            aria-label="Duplicate"
                            disabled={duplicate.isLoading}
                            onClick={() => duplicate.mutate({ id: p.id })}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-danger"
                            aria-label="Archive"
                            onClick={() => setArchiveId(p.id)}
                          >
                            <Archive className="h-4 w-4" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <label className="flex items-center gap-2 text-xs text-fg-subtle">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived pages
      </label>

      <ConfirmDialog
        open={!!archiveId}
        onOpenChange={(o) => !o && setArchiveId(null)}
        title={`Archive “${target?.name ?? "page"}”?`}
        description={
          target?.status === "published"
            ? "The page goes offline immediately and its subdomain is released. Archived pages can't be edited."
            : "Its subdomain (if any) is released. Archived pages can't be edited."
        }
        confirmLabel="Archive"
        destructive
        loading={archive.isLoading}
        onConfirm={() => {
          if (archiveId) archive.mutate({ id: archiveId });
          setArchiveId(null);
        }}
      />
    </div>
  );
}
