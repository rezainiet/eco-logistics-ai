"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";

const ALL_SCOPES = ["super_admin", "finance_admin", "support_admin"] as const;
type Scope = (typeof ALL_SCOPES)[number];

/**
 * Admin scope management. Super-admin only — surfaces a forbidden message
 * if the caller lacks the scope. Granting an empty array demotes the
 * merchant out of admin entirely.
 */
export default function AdminAccessPage() {
  const me = trpc.adminAccess.whoami.useQuery();
  const list = trpc.adminAccess.listAdmins.useQuery();
  const utils = trpc.useUtils();

  const [grantForm, setGrantForm] = useState({
    targetMerchantId: "",
    scopes: [] as Scope[],
  });

  const grant = trpc.adminAccess.grantScopes.useMutation({
    onSuccess: () => {
      toast.success("Scopes updated");
      setGrantForm({ targetMerchantId: "", scopes: [] });
      utils.adminAccess.listAdmins.invalidate();
    },
    onError: (err) => toast.error("Update failed", err.message),
  });

  const isSuper = (me.data?.scopes ?? []).includes("super_admin");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Access control"
        description="Grant and revoke admin scopes. super_admin only."
      />

      {!isSuper ? (
        <Card>
          <CardContent className="py-6 text-sm text-fg-subtle">
            You need <code>super_admin</code> to manage access. Ask another
            super_admin to grant you the scope.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Existing admins</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Business</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.email}</TableCell>
                  <TableCell>{a.businessName}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {a.scopes.length === 0 ? (
                        <span className="text-xs text-fg-faint">none</span>
                      ) : (
                        a.scopes.map((s) => (
                          <Badge
                            key={s}
                            className="bg-info-subtle text-info"
                          >
                            {s}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-2xs">{a.id}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isSuper ? (
        <Card>
          <CardHeader>
            <CardTitle>Grant or revoke scopes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label>Target merchant ID</Label>
              <Input
                value={grantForm.targetMerchantId}
                onChange={(e) =>
                  setGrantForm((f) => ({
                    ...f,
                    targetMerchantId: e.target.value,
                  }))
                }
                placeholder="ObjectId"
              />
            </div>
            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="flex flex-wrap gap-3">
                {ALL_SCOPES.map((s) => (
                  <label
                    key={s}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={grantForm.scopes.includes(s)}
                      onChange={(e) =>
                        setGrantForm((f) => ({
                          ...f,
                          scopes: e.target.checked
                            ? [...f.scopes, s]
                            : f.scopes.filter((x) => x !== s),
                        }))
                      }
                    />
                    {s}
                  </label>
                ))}
              </div>
              <p className="text-xs text-fg-subtle">
                Selecting nothing demotes the merchant out of admin.
              </p>
            </div>
            <Button
              onClick={() => grant.mutate(grantForm)}
              disabled={!grantForm.targetMerchantId || grant.isPending}
            >
              Apply
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
