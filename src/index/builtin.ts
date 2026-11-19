import type { Host } from "../host/Host";
import { numberLines } from "../tools/fs";
import type { ScriptTool } from "../tools/scripttools";
import { enclosingSymbol, renderOutline, Sym, symbolRange } from "./symbols";
import type { WorkspaceIndex } from "./WorkspaceIndex";

/**
 * Vestavěné nástroje pro <call>: běží přímo v rozšíření nad indexem workspace, bez spouštění skriptu.
 * Odpovídají hned a šetří kola: model se zeptá „kde je X definováno“, „ukaž tělo X“, „kdo X volá“
 * jedním voláním, místo aby skládal hledání a čtení souborů po částech.
 */

export interface BuiltinContext {
  host: Host;
}

export type BuiltinHandler = (args: Record<string, unknown>, ctx: BuiltinContext) => Promise<string>;

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const int = (v: unknown, def: number, min: number, max: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def);

function needIndex(ctx: BuiltinContext): WorkspaceIndex {
  const index = ctx.host.index;
  if (!index) throw new Error("The workspace index is switched off (setting copyAgent.index.enabled); use <grep>, <glob> and <read> instead.");
  return index;
}

/** Počká na přečtení souborů; když to trvá, vrátí poznámku, že výsledek může být neúplný. */
async function deepNote(index: WorkspaceIndex): Promise<string> {
  const done = await index.whenDeep(20_000);
  if (done) return "";
  const st = index.stats();
  return `\n(the index is still reading files: ${st.indexed} of ${st.files} done; results may be incomplete, ask again in a moment)`;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function day(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Soubory podle volitelného globu (bez něj všechny). */
async function scope(index: WorkspaceIndex, glob: string): Promise<string[]> {
  if (!glob) return index.list();
  // cesta k souboru nebo složce bez hvězdiček: soubor sám, nebo vše pod složkou
  if (!/[*?[{]/.test(glob)) {
    const clean = glob.replace(/\\/g, "/").replace(/\/+$/, "");
    if (index.has(clean)) return [clean];
    return index.match(`${clean}/**/*`);
  }
  return index.match(glob);
}

const files: BuiltinHandler = async (args, ctx) => {
  const index = needIndex(ctx);
  const query = str(args.query).trim();
  const limit = int(args.limit, 40, 1, 300);
  const sort = str(args.sort) || "match";
  let found: string[];
  if (/[*?[{]/.test(query)) found = await index.match(query);
  else {
    const parts = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = await index.list();
    found = parts.length ? all.filter((f) => { const l = f.toLowerCase(); return parts.every((p) => l.includes(p)); }) : all;
    if (sort === "match" && parts.length) {
      // nejdřív shoda v názvu souboru, pak kratší cesta
      const rank = (f: string) => { const base = (f.split("/").pop() ?? f).toLowerCase(); return (parts.every((p) => base.includes(p)) ? 0 : 1) * 10_000 + (base.startsWith(parts[0]) ? 0 : 1000) + f.length; };
      found = found.map((f) => [f, rank(f)] as const).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([f]) => f);
    }
  }
  if (sort === "recent") found = [...found].sort((a, b) => (index.entry(b)?.mtimeMs ?? 0) - (index.entry(a)?.mtimeMs ?? 0));
  else if (sort === "size") found = [...found].sort((a, b) => (index.entry(b)?.size ?? 0) - (index.entry(a)?.size ?? 0));
  if (!found.length) return `No files match "${query}".`;
  const shown = found.slice(0, limit);
  // počet řádků zná index až po přečtení souboru: u vypisovaných se dočte
  await Promise.all(shown.filter((f) => index.entry(f)?.lines === undefined && index.searchable(f)).map((f) => index.text(f)));
  const lines = shown.map((f) => {
    const e = index.entry(f);
    return `${f}${e ? ` (${e.lines ? `${e.lines} lines, ` : ""}${size(e.size)}, changed ${day(e.mtimeMs)})` : ""}`;
  });
  return lines.join("\n") + (found.length > shown.length ? `\n… (${found.length - shown.length} more; narrow the query or raise limit)` : "");
};

interface Hit {
  file: string;
  sym: Sym;
  rank: number;
}

/** Definice podle jména: `a|b` = více jmen, `obal.jmeno` = jen uvnitř balíku nebo třídy `obal`. */
async function findSymbols(index: WorkspaceIndex, name: string, glob: string, kind: string): Promise<Hit[]> {
  const among = new Set(await scope(index, glob));
  const wants = name
    .split("|")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
    .map((n) => { const dot = n.lastIndexOf("."); return dot > 0 ? { container: n.slice(0, dot), name: n.slice(dot + 1) } : { container: "", name: n }; });
  const k = kind.toLowerCase();
  const hits: Hit[] = [];
  for (const [file, sym] of index.allSymbols()) {
    if (!among.has(file)) continue;
    if (k && !sym.kind.includes(k)) continue;
    const n = sym.name.toLowerCase();
    let best = Infinity;
    for (const w of wants) {
      if (w.container && !(sym.container ?? "").toLowerCase().includes(w.container)) continue;
      const rank = n === w.name ? 0 : n.startsWith(w.name) ? 1 : n.includes(w.name) ? 2 : Infinity;
      if (rank < best) best = rank;
    }
    if (best !== Infinity) hits.push({ file, sym, rank: best });
  }
  return hits.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file) || a.sym.line - b.sym.line);
}

const symbols: BuiltinHandler = async (args, ctx) => {
  const index = needIndex(ctx);
  const name = str(args.name).trim();
  const note = await deepNote(index);
  const hits = await findSymbols(index, name, str(args.path), str(args.kind));
  if (!hits.length) return `No definition matching "${name}" found${str(args.kind) ? ` of kind "${str(args.kind)}"` : ""}. Try a shorter part of the name, or <grep> for it.${note}`;
  const limit = int(args.limit, 40, 1, 300);
  const out = hits.slice(0, limit).map((h) => `${h.file}:${h.sym.line}: ${h.sym.kind} ${h.sym.container ? `${h.sym.container}.` : ""}${h.sym.name}  |  ${h.sym.text}`);
  return out.join("\n") + (hits.length > limit ? `\n… (${hits.length - limit} more; narrow the name, add kind or path)` : "") + note;
};

const code: BuiltinHandler = async (args, ctx) => {
  const index = needIndex(ctx);
  const name = str(args.name).trim();
  const maxLines = int(args.max_lines, 250, 10, 2000);
  const note = await deepNote(index);
  let hits = await findSymbols(index, name, str(args.path), str(args.kind));
  // tělo se ukazuje jen u přesné shody jména; jinak by „get“ vypsal půl projektu
  const exact = hits.filter((h) => h.rank === 0);
  if (!exact.length) {
    if (!hits.length) return `No definition named "${name}" found. Use the tool "symbols" with a part of the name, or <grep>.${note}`;
    return `No definition is named exactly "${name}". Similar:\n${hits.slice(0, 20).map((h) => `${h.file}:${h.sym.line}: ${h.sym.kind} ${h.sym.container ? `${h.sym.container}.` : ""}${h.sym.name}`).join("\n")}${note}`;
  }
  hits = exact;
  const shown = hits.slice(0, 4);
  const parts: string[] = [];
  let budget = maxLines;
  for (const h of shown) {
    const text = await index.text(h.file);
    if (text === undefined) continue;
    const lines = text.split("\n");
    const syms = await index.symbolsOf(h.file);
    const at = syms.findIndex((s) => s.line === h.sym.line && s.name === h.sym.name);
    const range = at >= 0 ? symbolRange(lines, syms, at) : { from: h.sym.line, to: Math.min(lines.length, h.sym.line + 40) };
    const to = Math.min(range.to, range.from + Math.max(10, budget) - 1);
    budget -= to - range.from + 1;
    parts.push(
      `### ${h.file}:${range.from}-${to} (${h.sym.kind} ${h.sym.container ? `${h.sym.container}.` : ""}${h.sym.name})` +
        (to < range.to ? ` — cut, the definition continues to line ${range.to}: <read path="${h.file}" lines="${to + 1}-${range.to}"/>` : "") +
        `\n${numberLines(lines.slice(range.from - 1, to), range.from)}`,
    );
    if (budget <= 0) break;
  }
  const rest = hits.slice(parts.length);
  if (rest.length) parts.push(`Other definitions with this name (not shown):\n${rest.slice(0, 30).map((h) => `${h.file}:${h.sym.line}: ${h.sym.kind} ${h.sym.container ? `${h.sym.container}.` : ""}${h.sym.name}`).join("\n")}`);
  return parts.join("\n\n") + note;
};

const usages: BuiltinHandler = async (args, ctx) => {
  const index = needIndex(ctx);
  const name = str(args.name).trim();
  if (name.length < 2) throw new Error("name is too short");
  const limit = int(args.limit, 80, 1, 400);
  const among = (await scope(index, str(args.path))).filter((f) => index.searchable(f));
  const candidates = name.length >= 3 ? index.candidates([[name]], among) : among;
  const re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "i");
  const out: string[] = [];
  let total = 0;
  let filesWith = 0;
  await index.eachText(candidates, (f, text) => {
    if (text === undefined || !re.test(text)) return;
    const lines = text.split("\n");
    const syms = index.entry(f)?.symbols ?? [];
    let any = false;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total++;
      any = true;
      if (out.length >= limit) continue;
      const enc = enclosingSymbol(syms, i + 1);
      const isDef = !!enc && enc.line === i + 1 && enc.name.toLowerCase() === name.toLowerCase();
      out.push(`${f}:${i + 1}: ${isDef ? "[definition] " : enc ? `[in ${enc.container ? `${enc.container}.` : ""}${enc.name}] ` : ""}${lines[i].trim().slice(0, 220)}`);
    }
    if (any) filesWith++;
  });
  if (!total) return `No usage of "${name}" found${str(args.path) ? ` under ${str(args.path)}` : ""}.`;
  return `${total} occurrence(s) in ${filesWith} file(s)${total > out.length ? `, first ${out.length} shown` : ""}:\n${out.join("\n")}`;
};

const outline: BuiltinHandler = async (args, ctx) => {
  const index = needIndex(ctx);
  const path = str(args.path).trim();
  const limit = int(args.limit, 30, 1, 200);
  const found = await scope(index, path);
  if (!found.length) return `Nothing found at "${path}".`;
  const parts: string[] = [];
  let shown = 0;
  for (const f of found) {
    if (shown >= limit) break;
    if (!index.searchable(f)) continue;
    const syms = await index.symbolsOf(f);
    const e = index.entry(f);
    shown++;
    parts.push(`${f} (${e?.lines ?? "?"} lines)${syms.length ? `\n${renderOutline(syms, found.length === 1 ? 400 : 60)}` : " — no definitions recognised"}`);
  }
  const more = found.length - shown;
  return parts.join("\n\n") + (more > 0 ? `\n\n… (${more} more files; narrow the path or raise limit)` : "");
};

function tool(name: string, description: string, output: string, properties: ScriptTool["inputSchema"]["properties"], required: string[], examples: Record<string, unknown>[], builtin: BuiltinHandler): ScriptTool {
  return {
    name,
    description,
    output,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    run: "(built-in)",
    readOnly: true,
    timeout: 60,
    maxChars: 24_000,
    examples: examples.map((a) => ({ args: a })),
    dir: "",
    file: "",
    scope: "builtin",
    errors: [],
    builtin,
  };
}

/** Vestavěné nástroje; pořadí je i pořadím v promptu. */
export const BUILTIN_TOOLS: ScriptTool[] = [
  tool(
    "symbols",
    "Where something is DEFINED: procedures, functions, packages, classes, methods, types, tables, headings, found by (part of) the name, case-insensitive. Instant, from the index of the whole workspace",
    "lines `file:line: kind [container.]name | declaration`",
    {
      name: { type: "string", description: 'name or part of it; "a|b" for several; "pkg.proc" or "Class.method" to look only inside that package or class' },
      kind: { type: "string", description: "optional: procedure, function, package, class, method, type, table, view, trigger, heading…" },
      path: { type: "string", description: "optional folder, file or glob to look in" },
      limit: { type: "integer", default: 40, minimum: 1, maximum: 300 },
    },
    ["name"],
    [],
    symbols,
  ),
  tool(
    "code",
    "The SOURCE of a definition by its exact name (whole procedure, function, method, class or package body with line numbers), without knowing the file; use it instead of grep + read",
    "numbered source lines per definition, headed `### file:from-to (kind name)`",
    {
      name: { type: "string", description: 'exact name; "pkg.proc" or "Class.method" when the bare name is ambiguous' },
      kind: { type: "string" },
      path: { type: "string" },
      max_lines: { type: "integer", default: 250, minimum: 10, maximum: 2000 },
    },
    ["name"],
    [],
    code,
  ),
  tool(
    "usages",
    "Where an identifier is USED across the workspace (whole word, case-insensitive): every line with it, with the definition it sits in. For callers of a procedure, readers of a column, uses of a constant",
    "`N occurrences in M files`, then lines `file:line: [in container.name] text`",
    {
      name: { type: "string" },
      path: { type: "string" },
      limit: { type: "integer", default: 80, minimum: 1, maximum: 400 },
    },
    ["name"],
    [],
    usages,
  ),
  tool(
    "outline",
    "Structure of a file, or of every file in a folder, without reading them: the definitions with their line numbers",
    "per file `path (N lines)` and lines `Lnn: declaration`",
    {
      path: { type: "string", description: "file, folder or glob" },
      limit: { type: "integer", default: 30, minimum: 1, maximum: 200 },
    },
    ["path"],
    [],
    outline,
  ),
  tool(
    "files",
    "Find files by parts of their name or path (all parts must be present, case-insensitive) or by a glob; with size, line count and time of the last change",
    "lines `path (N lines, size, changed YYYY-MM-DD hh:mm)`",
    {
      query: { type: "string", description: 'parts of the path separated by spaces, e.g. "faktur pkg", or a glob like "**/*.pkb"; empty = all files' },
      sort: { enum: ["match", "recent", "size"], default: "match", description: "recent = last changed first" },
      limit: { type: "integer", default: 40, minimum: 1, maximum: 300 },
    },
    [],
    [],
    files,
  ),
];
