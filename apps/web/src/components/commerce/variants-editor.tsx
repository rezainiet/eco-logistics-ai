"use client";

import { useRef, useState } from "react";
import { ImagePlus, Loader2, Plus, Trash2, Wand2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * Optional "Variants" section of the product form: up to 3 options (e.g.
 * Color, Size), each with its values, and one row per combination with its
 * own image, price, SKU and stock. Stock of an existing variant is read-only
 * here — it changes through "Adjust stock", so every change is ledgered.
 */

export const MAX_OPTIONS = 3;

export interface OptionRow {
  name: string;
  /** Comma-separated as typed. */
  values: string;
}

export interface VariantRow {
  id?: string;
  optionValues: string[];
  price: string;
  /** Optional "was" price shown struck through; must be above the variant's price. */
  compareAt: string;
  sku: string;
  initialStock: string;
  /**
   * A variant's own cost, if one was set (e.g. by import/API). Not edited here —
   * variants use the product's cost price — but kept unchanged on save.
   */
  costPrice?: number | null;
  onHand?: number;
  reserved?: number;
  imageAssetId: string | null;
  imageUrl: string | null;
  active: boolean;
}

export const splitValues = (s: string) =>
  s
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, i, all) => all.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i);

const comboKey = (values: string[]) => values.map((v) => v.toLowerCase()).join("\u0000");

/** Every combination of the options' values, keeping existing rows for combinations that still exist. */
export function buildCombinations(options: OptionRow[], existing: VariantRow[]): VariantRow[] {
  const lists = options.map((o) => splitValues(o.values));
  if (!lists.length || lists.some((l) => !l.length)) return existing;
  let combos: string[][] = [[]];
  for (const list of lists) combos = combos.flatMap((c) => list.map((v) => [...c, v]));
  const byKey = new Map(existing.map((r) => [comboKey(r.optionValues), r]));
  return combos.slice(0, 100).map(
    (values) => byKey.get(comboKey(values)) ?? { optionValues: values, price: "", compareAt: "", sku: "", initialStock: "0", imageAssetId: null, imageUrl: null, active: true },
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

export function VariantsEditor({
  enabled,
  onEnabledChange,
  options,
  onOptionsChange,
  rows,
  onRowsChange,
  basePrice,
  editing,
}: {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  options: OptionRow[];
  onOptionsChange: (o: OptionRow[]) => void;
  rows: VariantRow[];
  onRowsChange: (r: VariantRow[]) => void;
  basePrice: string;
  editing: boolean;
}) {
  const upload = trpc.landingPages.uploadAsset.useMutation();
  const [uploadingRow, setUploadingRow] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const targetRow = useRef<number | null>(null);

  const setRow = (i: number, patch: Partial<VariantRow>) => onRowsChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const onFile = async (file: File | undefined) => {
    const i = targetRow.current;
    if (!file || i === null) return;
    setUploadingRow(i);
    try {
      const r = await upload.mutateAsync({ dataUrl: await readAsDataUrl(file) });
      setRow(i, { imageAssetId: r.id, imageUrl: r.url });
    } catch (e) {
      toast.error("Image not uploaded", (e as Error).message);
    } finally {
      setUploadingRow(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-stroke/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Variants</div>
          <p className="text-2xs text-fg-subtle">For products that come in options like size or color — each with its own price, stock and photo.</p>
        </div>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label="This product has variants" />
      </div>

      {enabled ? (
        <>
          <div className="space-y-2">
            {options.map((o, i) => (
              <div key={i} className="grid grid-cols-[1fr_2fr_auto] items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor={`opt-name-${i}`} className="text-xs">
                    Option {i + 1}
                  </Label>
                  <Input id={`opt-name-${i}`} value={o.name} maxLength={30} placeholder={i === 0 ? "Color" : "Size"} onChange={(e) => onOptionsChange(options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`opt-values-${i}`} className="text-xs">
                    Values (comma separated)
                  </Label>
                  <Input
                    id={`opt-values-${i}`}
                    value={o.values}
                    placeholder={i === 0 ? "Red, Blue, Black" : "S, M, L, XL"}
                    onChange={(e) => onOptionsChange(options.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))}
                  />
                </div>
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove option ${i + 1}`} disabled={options.length <= 1} onClick={() => onOptionsChange(options.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              {options.length < MAX_OPTIONS ? (
                <Button type="button" variant="outline" size="sm" onClick={() => onOptionsChange([...options, { name: "", values: "" }])}>
                  <Plus className="mr-1 h-4 w-4" /> Add option
                </Button>
              ) : null}
              <Button type="button" size="sm" onClick={() => onRowsChange(buildCombinations(options, rows))}>
                <Wand2 className="mr-1 h-4 w-4" /> Build combinations
              </Button>
            </div>
          </div>

          {rows.length ? (
            <div className="overflow-x-auto rounded-md border border-stroke/10">
              <table className="w-full text-sm">
                <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
                  <tr>
                    <th className="px-2 py-2 font-medium">Variant</th>
                    <th className="px-2 py-2 font-medium">Photo</th>
                    <th className="px-2 py-2 font-medium">Price</th>
                    <th className="px-2 py-2 font-medium">Compare-at</th>
                    <th className="px-2 py-2 font-medium">SKU</th>
                    <th className="px-2 py-2 font-medium">Stock</th>
                    <th className="px-2 py-2 font-medium">Active</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-stroke/8">
                  {rows.map((r, i) => (
                    <tr key={r.id ?? r.optionValues.join("|")}>
                      <td className="whitespace-nowrap px-2 py-1.5 font-medium">{r.optionValues.join(" / ")}</td>
                      <td className="px-2 py-1.5">
                        <div className="relative h-10 w-10 overflow-hidden rounded-md border border-stroke/14 bg-surface-raised">
                          {r.imageUrl ? (
                            <>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={r.imageUrl} alt="" className="h-full w-full object-cover" />
                              <button type="button" aria-label="Remove photo" onClick={() => setRow(i, { imageAssetId: null, imageUrl: null })} className="absolute right-0 top-0 rounded-bl bg-black/60 p-0.5 text-white">
                                <X className="h-3 w-3" />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Upload photo for ${r.optionValues.join(" / ")}`}
                              onClick={() => {
                                targetRow.current = i;
                                fileRef.current?.click();
                              }}
                              className="flex h-full w-full items-center justify-center text-fg-subtle hover:text-fg"
                            >
                              {uploadingRow === i ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input className="h-9 w-24" inputMode="decimal" value={r.price} placeholder={basePrice || "Price"} onChange={(e) => setRow(i, { price: e.target.value })} aria-label="Variant price" />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input className="h-9 w-24" inputMode="decimal" value={r.compareAt} placeholder="Optional" onChange={(e) => setRow(i, { compareAt: e.target.value })} aria-label="Variant compare-at price" />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input className="h-9 w-28" value={r.sku} maxLength={64} placeholder="Optional" onChange={(e) => setRow(i, { sku: e.target.value })} aria-label="Variant SKU" />
                      </td>
                      <td className="px-2 py-1.5">
                        {r.id ? (
                          <span className="tabular-nums text-fg-subtle" title="Change with Adjust stock">
                            {r.onHand ?? 0}
                            {r.reserved ? <span className="text-2xs"> ({r.reserved} reserved)</span> : null}
                          </span>
                        ) : (
                          <Input className="h-9 w-20" inputMode="numeric" value={r.initialStock} onChange={(e) => setRow(i, { initialStock: e.target.value })} aria-label="Starting stock" />
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Switch checked={r.active} onCheckedChange={(v) => setRow(i, { active: v })} aria-label="Variant active" />
                      </td>
                      <td className="px-2 py-1.5">
                        <Button type="button" variant="ghost" size="sm" aria-label="Remove variant" disabled={!!r.id && ((r.onHand ?? 0) > 0 || (r.reserved ?? 0) > 0)} onClick={() => onRowsChange(rows.filter((_, j) => j !== i))}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-fg-subtle">Add options and their values, then “Build combinations”.</p>
          )}
          <p className="text-2xs text-fg-faint">
            Empty price = the product price. Compare-at (optional) is the higher “was” price shown struck through. Profit reports use the
            product&apos;s cost price for every variant. {editing ? "Existing variants' stock changes with “Adjust stock”; a variant with stock can be made inactive instead of removed." : "Starting stock is recorded in each variant's stock history."}
          </p>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        </>
      ) : null}
    </div>
  );
}
