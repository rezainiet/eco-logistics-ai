import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Radix Dialog/Sheet content without a Title logs an accessibility error
 * and leaves screen-reader users without a name for the dialog (live
 * console finding: the mobile navigation sheet). Every file that renders
 * dialog/sheet content must also render a title (visually hidden is fine).
 */
const SRC = fileURLToPath(new URL("../..", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith(".tsx") && !p.endsWith(".test.tsx") ? [p] : [];
  });
}

describe("dialogs and sheets have accessible titles", () => {
  it("every <DialogContent>/<SheetContent> file also renders a matching Title", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      if (rel.startsWith("components/ui/")) continue; // the primitives themselves
      const src = readFileSync(file, "utf8");
      const contents = src.match(/<(Dialog|Sheet|AlertDialog)Content\b/g)?.length ?? 0;
      const titles = src.match(/<(Dialog|Sheet|AlertDialog)Title\b/g)?.length ?? 0;
      if (contents > titles) offenders.push(`${rel} (content ${contents}, titles ${titles})`);
    }
    expect(offenders).toEqual([]);
  });
});
