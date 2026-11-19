import { Host } from "../host/Host";
import { requiredFragments } from "../index/tokens";
import { ActionResult } from "../protocol/schema";

const MAX_FILE_CHARS = 512 * 1024;
const MAX_MATCHES = 150;
const CONCURRENCY = 16;

/**
 * Rychlá předběžná zkouška celého textu najednou: soubor bez shody se pak vůbec nedělí na řádky.
 * Jde jen u výrazů bez pohledů dopředu a dozadu (ty by přes konec řádku mohly dopadnout jinak než
 * po řádcích); shoda navíc přes hranici řádku nevadí, jen se soubor projde zbytečně.
 */
function wholeTextProbe(pattern: string): RegExp | undefined {
  if (/\(\?<?[=!]/.test(pattern)) return undefined;
  try {
    return new RegExp(pattern, "im");
  } catch {
    return undefined;
  }
}

/** Sbírá shody jednoho souboru do výstupu; vrací, kolik jich bylo. */
function collect(f: string, text: string, re: RegExp, context: number, out: string[], budget: number, probe?: RegExp): number {
  if (probe && !probe.test(text)) return 0;
  const lines = text.split("\n");
  const hits: number[] = [];
  for (let n = 0; n < lines.length && hits.length < budget; n++) if (re.test(lines[n])) hits.push(n);
  if (!hits.length) return 0;
  if (!context) {
    for (const n of hits) out.push(`${f}:${n + 1}: ${lines[n].slice(0, 300)}`);
    return hits.length;
  }
  const hitSet = new Set(hits);
  let printedTo = -1;
  for (const n of hits) {
    const from = Math.max(0, n - context, printedTo + 1);
    const to = Math.min(lines.length - 1, n + context);
    if (from > to) continue;
    if (printedTo >= 0 && from > printedTo + 1) out.push("--");
    for (let q = from; q <= to; q++) out.push(`${f}:${q + 1}${hitSet.has(q) ? ":" : "-"} ${lines[q].slice(0, 300)}`);
    printedTo = to;
  }
  out.push("--");
  return hits.length;
}

/**
 * Grep nad soubory workspace, výstup v pořadí cest. S indexem se čtou jen soubory, které hledaný text
 * podle svého otisku mohou obsahovat (a ty už bývají v paměti); bez indexu se čte všechno z disku.
 */
export async function toolGrep(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  let re: RegExp;
  try {
    re = new RegExp(attrs.pattern, "i");
  } catch (e) {
    return { tool: "grep", attrs, status: "error", output: `Invalid regex: ${(e as Error).message}` };
  }
  const context = Math.min(5, Math.max(0, Number(attrs.context) || 0));
  const out: string[] = [];
  let matches = 0;
  let scanned = 0;
  const index = host.index;
  if (index) {
    const all = await index.match(attrs.glob || "**/*");
    const files = all.filter((f) => index.searchable(f));
    const branches = requiredFragments(attrs.pattern);
    let candidates = branches ? index.candidates(branches, files) : files;
    // neuložené texty z editoru v otiscích nejsou: prohledají se vždy
    const unsaved = index.unsavedTexts();
    if (branches && unsaved.size) {
      const set = new Set(candidates);
      const extra = files.filter((f) => unsaved.has(f) && !set.has(f));
      if (extra.length) candidates = [...candidates, ...extra].sort();
    }
    scanned = files.length;
    const probe = wholeTextProbe(attrs.pattern);
    await index.eachText(candidates, (f, text) => {
      if (text === undefined) return;
      matches += collect(f, text, re, context, out, MAX_MATCHES - matches, probe);
      return matches < MAX_MATCHES;
    });
  } else {
    const files = await host.listFiles(attrs.glob || "**/*", 5000);
    for (let i = 0; i < files.length && matches < MAX_MATCHES; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      const texts = await Promise.all(batch.map((f) => host.readFile(f).catch(() => undefined)));
      for (let k = 0; k < batch.length && matches < MAX_MATCHES; k++) {
        const text = texts[k];
        if (text === undefined || text.length > MAX_FILE_CHARS || text.includes("\u0000")) continue;
        scanned++;
        matches += collect(batch[k], text, re, context, out, MAX_MATCHES - matches);
      }
    }
  }
  const capped = matches >= MAX_MATCHES ? `\n… (capped at ${MAX_MATCHES} matches; narrow the pattern or glob)` : "";
  return { tool: "grep", attrs, status: "ok", output: (out.join("\n") || "(no matches)") + capped, meta: { matches, files: scanned } };
}
