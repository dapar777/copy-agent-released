import { diffLines } from "../protocol/diff";

/**
 * Sada změn pro rozšíření Review změn (dapar.vscode-review) a popisy změn od modelu.
 * Čistá logika bez `vscode`: rozsahy řádků, které akce změnila, jejich přepočet na aktuální znění
 * souboru, data pro review (agent.json) a vrácení zamítnutého kusu.
 */

/** Popis změny od modelu (<change> hned za akcí, která změnu udělala). */
export interface ChangeNote {
  path: string;
  turn: number;
  kind: "create" | "modify" | "delete";
  /** znění souboru před akcí a po ní */
  before: string;
  after: string;
  title: string;
  text: string;
  risk?: string;
  step?: string;
}

export interface Range {
  od: number;
  do: number;
}

/** Soubor čekající na schválení: `live` je aktuální znění, u smazaného souboru chybí. */
export interface PendingFile {
  path: string;
  /** absolutní cesta na disku; do dat review jde ona, aby nezáleželo na tom, odkud se cesty počítají */
  abs: string;
  kind: "create" | "modify" | "delete";
  baseline: string;
  live?: string;
}

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const lineCount = (s: string) => {
  const l = norm(s).split("\n");
  return l[l.length - 1] === "" ? l.length - 1 : l.length;
};

/** Rozsahy řádků nového znění (od 1), které akce změnila. Čisté smazání dává dvojici řádků kolem něj. */
export function changedRanges(before: string, after: string): Range[] {
  const total = Math.max(1, lineCount(after));
  return diffLines(norm(before), norm(after)).map((h) =>
    h.newLines.length ? { od: h.newStart + 1, do: h.newStart + h.newLines.length } : { od: Math.max(1, h.newStart), do: Math.min(total, h.newStart + 1) },
  );
}

/** Přepočte rozsah řádků ze znění `from` do znění `to`; `undefined`, když z něj nic nezbylo. */
export function mapRange(r: Range, from: string, to: string): Range | undefined {
  const hunks = diffLines(norm(from), norm(to));
  let lo = Infinity;
  let hi = -Infinity;
  for (let line = r.od; line <= r.do; line++) {
    let offset = 0;
    let hit: [number, number] | null | undefined;
    for (const h of hunks) {
      if (line - 1 < h.oldStart) break;
      if (line - 1 < h.oldStart + h.oldLines.length) {
        hit = h.newLines.length ? [h.newStart + 1, h.newStart + h.newLines.length] : null; // řádek později přepsaný nebo smazaný
        break;
      }
      offset += h.newLines.length - h.oldLines.length;
    }
    if (hit === null) continue;
    const [a, b] = hit ?? [line + offset, line + offset];
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  return lo <= hi ? { od: lo, do: hi } : undefined;
}

const RISK: Record<string, string> = { high: "vysoke", vysoke: "vysoke", vysoka: "vysoke", medium: "stredni", stredni: "stredni", low: "nizke", nizke: "nizke", nizka: "nizke" };
const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/**
 * Data pro Review změn z popisů modelu: každý popis je kus (rozsah řádků v aktuálním znění souboru),
 * `step` z popisů dává kroky plánu. Bez použitelného popisu vrací `null` a review běží bez dat agenta.
 */
export function buildAgentData(notes: ChangeNote[], files: PendingFile[], title: string): Record<string, unknown> | null {
  const byPath = new Map(files.map((f) => [f.path, f]));
  interface Piece { id: string; note: ChangeNote; order: number; json: Record<string, unknown> }
  const pieces: Piece[] = [];
  const covered = new Map<string, Set<number>>();
  // Od nejnovějšího popisu: řádky, které pozdější akce přepsala, patří jejímu popisu.
  for (let k = notes.length - 1; k >= 0; k--) {
    const n = notes[k];
    const f = byPath.get(n.path);
    if (!f) continue; // změna už přijatá nebo vrácená
    const risk = RISK[plain(n.risk ?? "")] ?? "nizke";
    const base = { soubor: f.abs, popis: n.text.trim(), ...(risk !== "nizke" ? { riziko: { uroven: risk, duvod: "" } } : {}) };
    if (f.kind === "delete" || f.live === undefined) {
      if (covered.has(n.path)) continue;
      covered.set(n.path, new Set([0]));
      pieces.push({ id: `n${k + 1}`, note: n, order: k, json: { ...base, stare: { od: 1, do: Math.max(1, lineCount(f.baseline)) }, titulek: n.title.trim() } });
      continue;
    }
    const whole = n.kind === "create" && f.kind === "create";
    const live = f.live;
    const ranges = (whole ? [{ od: 1, do: Math.max(1, lineCount(n.after)) }] : changedRanges(n.before, n.after))
      .map((r) => mapRange(r, n.after, live))
      .filter((r): r is Range => !!r);
    const seen = covered.get(n.path) ?? new Set<number>();
    covered.set(n.path, seen);
    const free = ranges.filter((r) => { for (let l = r.od; l <= r.do; l++) if (!seen.has(l)) return true; return false; });
    free.forEach((r, j) => {
      for (let l = r.od; l <= r.do; l++) seen.add(l);
      pieces.push({ id: free.length > 1 ? `n${k + 1}-${j + 1}` : `n${k + 1}`, note: n, order: k + j / 1000, json: { ...base, radky: r, titulek: n.title.trim() + (free.length > 1 ? ` (${j + 1}/${free.length})` : "") } });
    });
  }
  if (!pieces.length) return null;
  const chrono = [...pieces].sort((a, b) => a.order - b.order);
  const steps: { nazev: string; kusy: string[] }[] = [];
  const stepOf = (name: string) => steps.find((s) => s.nazev === name) ?? (steps.push({ nazev: name, kusy: [] }), steps[steps.length - 1]);
  const named = chrono.filter((p) => p.note.step?.trim());
  for (const p of named) stepOf(p.note.step!.trim()).kusy.push(p.id);
  // Popsané změny bez kroku nejsou „mimo plán“: dostanou vlastní krok na konci.
  if (named.length) for (const p of chrono.filter((x) => !x.note.step?.trim())) stepOf("Další změny").kusy.push(p.id);
  return {
    verze: 2,
    vytvoreno: new Date().toISOString(),
    souhrn: { titulek: title.split("\n")[0].trim().slice(0, 72) },
    // pořadí kusů: novější první, aby při překryvu rozsahů vyhrál pozdější popis
    kusy: pieces.map((p) => ({ id: p.id, ...p.json })),
    plan: steps.map((s, i) => ({ krok: i + 1, nazev: s.nazev, kusy: s.kusy })),
  };
}

/** Úprava, kterou Review změn vrací zamítnutý kus: na řádku `radek` nového znění odebrat řádky a vložit původní. */
export interface RevertEdit {
  radek: number;
  odebrat: number;
  vlozit: string[];
}

/** Vrátí zamítnuté řádky do znění souboru. Úpravy se počítají proti stejnému znění, proto jdou odzadu. */
export function applyRevert(live: string, edits: RevertEdit[]): string {
  const lines = norm(live).split("\n");
  for (const e of [...edits].sort((a, b) => b.radek - a.radek)) lines.splice(Math.max(0, e.radek - 1), Math.max(0, e.odebrat), ...e.vlozit);
  return lines.join("\n");
}

/** Soubor sady pro Review změn. Znění před změnou leží vedle něj ve složce `base/` pod číslem. */
export function buildManifest(files: PendingFile[], title: string): { manifest: Record<string, unknown>; bases: { name: string; content: string }[] } {
  const bases: { name: string; content: string }[] = [];
  const soubory = files.map((f, i) => {
    const stav = f.kind === "create" ? "pridan" : f.kind === "delete" ? "smazan" : "upraven";
    if (f.kind === "create") return { soubor: f.abs, stav };
    const name = `base/${i + 1}-${f.path.split("/").pop()}`;
    bases.push({ name, content: f.baseline });
    return { soubor: f.abs, stav, puvodni: name };
  });
  return {
    manifest: {
      verze: 1,
      nazev: `Copy Agent: ${title.split("\n")[0].trim().slice(0, 60) || "změny"}`,
      puvod: "copy-agent",
      vytvoreno: new Date().toISOString(),
      prikazy: { prijmout: "copyAgent.review.acceptAll", zamitnout: "copyAgent.review.revert" },
      soubory,
    },
    bases,
  };
}
