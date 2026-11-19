/**
 * Symboly (definice) v souboru: procedury, funkce, balíky, třídy, metody, nadpisy. Hledají se
 * regulárními výrazy po řádcích, bez parseru: stačí to na „kde je X definováno“, osnovu souboru
 * a vytažení těla definice. Jazyk se pozná z přípony.
 */

export interface Sym {
  name: string;
  /** procedure, function, package, class, method, type, table, view, trigger, const, heading… */
  kind: string;
  /** řádek od 1 */
  line: number;
  /** úroveň vnoření (0 = nejvyšší); u nadpisů úroveň nadpisu − 1 */
  level: number;
  /** řádek definice (oříznutý) */
  text: string;
  /** obalující symbol (balík, třída) */
  container?: string;
}

type Family = "sql" | "brace" | "python" | "markdown" | "ruby" | "other";

export function familyOf(path: string): Family {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  if (["sql", "pls", "plb", "pks", "pkb", "pck", "prc", "fnc", "trg", "tps", "tpb", "vw", "ddl"].includes(ext)) return "sql";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "cs", "kt", "kts", "swift", "scala", "go", "rs", "c", "h", "cc", "cpp", "hpp", "php", "dart", "groovy"].includes(ext)) return "brace";
  if (["py", "pyw", "pyi"].includes(ext)) return "python";
  if (["md", "markdown", "rst", "txt"].includes(ext)) return "markdown";
  if (["rb"].includes(ext)) return "ruby";
  return "other";
}

const SQL_UNIT = /^\s*(?:create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:force\s+)?)?(package\s+body|package|type\s+body|procedure|function|trigger|(?:materialized\s+)?view|table|sequence|synonym|index|type)\s+(?:if\s+not\s+exists\s+)?((?:"?[\w$#]+"?\.)?"?[\w$#]+"?)/i;
const SQL_INNER = /^\s*(procedure|function|cursor|type|subtype)\s+("?[\w$#]+"?)/i;

const BRACE_TOP =
  /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|sealed\s+|partial\s+|async\s+|pub(?:\([^)]*\))?\s+|unsafe\s+|extern\s+)*(function\*?|class|interface|type|enum|namespace|module|struct|trait|impl|fn|func|object|record|const|let|var)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/;
const BRACE_METHOD = /^(?:(?:public|private|protected|internal|static|async|override|readonly|final|abstract|virtual|synchronized|suspend|open|fun|func|def)\s+)*(?:get\s+|set\s+)?(?:[\w$<>\[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\([^;]*$/;
const BRACE_KEYWORD = /^(if|for|while|switch|return|else|catch|do|try|new|throw|await|yield|case|typeof|delete|super|this|function|using|lock|foreach|when)$/;

function clip(l: string): string {
  const t = l.trim().replace(/\s+/g, " ");
  return t.length > 140 ? t.slice(0, 137) + "…" : t;
}

function indentOf(l: string): number {
  let n = 0;
  for (const ch of l) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/**
 * Řádky, které mohou být definicí: najde je jeden regulární výraz přes celý text (běží v jádře
 * prohlížeče výrazů, ne po řádcích v JavaScriptu), podrobně se pak zkoumají jen ony.
 */
const CANDIDATES: Record<Exclude<Family, "other" | "sql">, RegExp> = {
  python: /^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+[A-Za-z_][^\n]*/gm,
  ruby: /^[ \t]*(?:def|class|module)[ \t]+[A-Za-z_][^\n]*/gm,
  markdown: /^(?:#{1,6}[ \t]+[^\n]+|[ \t]*(?:```|~~~)[^\n]*)/gm,
  brace:
    /^(?:[ \t]*(?:export|declare|public|private|protected|internal|static|final|abstract|sealed|partial|async|pub|unsafe|extern|override|readonly|virtual|synchronized|suspend|open|fun|def|function|class|interface|type|enum|namespace|module|struct|trait|impl|fn|func|object|record|const|let|var|get|set)\b[^\n]*|[ \t]*\}[^\n]*|[ \t]+[A-Za-z_$][^\n;(]*\([^\n;]*)$/gm,
};

/** Projde kandidátní řádky textu: řádek a jeho číslo (od 1). */
function eachCandidate(text: string, re: RegExp, fn: (line: string, lineNo: number) => void): void {
  re.lastIndex = 0;
  let lineNo = 1;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (let k = text.indexOf("\n", pos); k >= 0 && k < m.index; k = text.indexOf("\n", k + 1)) lineNo++;
    pos = m.index;
    if (m[0].length === 0) re.lastIndex++;
    else fn(m[0], lineNo);
  }
}

const SQL_KEYWORD = /^[ \t]*(?:create|package|procedure|function|cursor|type|subtype|trigger|end)\b/i;

/**
 * Řádky, jejichž první znak (po odsazení) je jeden z `first`: bez regulárního výrazu a bez kopírování
 * řádků, které nevyhovují. U PL/SQL tím odpadne naprostá většina řádků (přiřazení, volání).
 */
function eachLineStarting(text: string, first: string, fn: (line: string, lineNo: number) => void): void {
  const n = text.length;
  let start = 0;
  let lineNo = 1;
  while (start <= n) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = n;
    let i = start;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 9) break;
      i++;
    }
    if (i < end && first.includes(text[i])) fn(text.slice(start, end), lineNo);
    start = end + 1;
    lineNo++;
  }
}

/** Symboly souboru v pořadí řádků. Texty nad 2 miliony znaků se neprocházejí. */
export function extractSymbols(text: string, path: string): Sym[] {
  const family = familyOf(path);
  if (family === "other" || text.length > 2_000_000) return [];
  const out: Sym[] = [];
  if (family === "sql") {
    // jednotka = balík nebo tělo typu; procedury a funkce uvnitř ní jsou o úroveň níž
    let unit: string | undefined;
    let unitEnd: RegExp | undefined;
    const enter = (name: string | undefined) => {
      unit = name;
      unitEnd = name ? new RegExp(`^\\s*end\\s+"?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*;`, "i") : undefined;
    };
    eachLineStarting(text, "cCpPfFtTsSeE", (l, line) => {
      if (!SQL_KEYWORD.test(l)) return;
      if (unitEnd?.test(l)) {
        enter(undefined);
        return;
      }
      const create = /^\s*create\b/i.test(l);
      const u = SQL_UNIT.exec(l);
      if (u && (create || (indentOf(l) === 0 && /^(package|procedure|function|trigger|type)/i.test(u[1])))) {
        const kind = u[1].toLowerCase().replace(/\s+/g, " ");
        const name = (u[2].split(".").pop() ?? u[2]).replace(/"/g, "");
        if (/^(package|type body)/.test(kind)) {
          out.push({ name, kind, line, level: 0, text: clip(l) });
          enter(name);
          return;
        }
        if (create || !unit) {
          out.push({ name, kind, line, level: 0, text: clip(l) });
          if (create) enter(undefined);
          return;
        }
      }
      const m = SQL_INNER.exec(l);
      if (!m) return;
      const name = m[2].replace(/"/g, "");
      if (unit) out.push({ name, kind: m[1].toLowerCase(), line, level: 1, text: clip(l), container: unit });
      else if (indentOf(l) === 0) out.push({ name, kind: m[1].toLowerCase(), line, level: 0, text: clip(l) });
    });
    return out;
  }
  const candidates = CANDIDATES[family];
  if (family === "markdown") {
    let fence = false;
    eachCandidate(text, candidates, (l, line) => {
      if (/^\s*(```|~~~)/.test(l)) {
        fence = !fence;
        return;
      }
      if (fence) return;
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
      if (m) out.push({ name: m[2], kind: "heading", line, level: m[1].length - 1, text: clip(l) });
    });
    return out;
  }
  if (family === "python" || family === "ruby") {
    const stack: { indent: number; name: string }[] = [];
    const re = family === "python" ? /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/ : /^(\s*)(def|class|module)\s+([A-Za-z_][\w.?!]*)/;
    eachCandidate(text, candidates, (l, line) => {
      const m = re.exec(l);
      if (!m) return;
      const indent = indentOf(m[1]);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const container = stack[stack.length - 1]?.name;
      const kind = m[2] === "def" ? (container && /^[A-Z]/.test(container) ? "method" : "function") : m[2];
      out.push({ name: m[3], kind, line, level: stack.length, text: clip(l), container });
      stack.push({ indent, name: m[3] });
    });
    return out;
  }
  let container: { name: string; indent: number } | undefined;
  eachCandidate(text, candidates, (l, line) => {
    const indent = indentOf(l);
    const body = l.trim();
    if (body.startsWith("}")) {
      // zavírací závorka na úrovni třídy (nebo výš) ji ukončuje
      if (container && indent <= container.indent) container = undefined;
      return;
    }
    if (container && indent <= container.indent) container = undefined;
    const top = BRACE_TOP.exec(body);
    if (top && (indent === 0 || /^(class|interface|enum|struct|trait|impl|namespace|module|object|record|function\*?|fn|func)$/.test(top[1]))) {
      const kind = top[1].replace("*", "");
      // lokální const/let uvnitř funkce symbol není
      if (indent > 0 && /^(const|let|var|type)$/.test(kind)) return;
      const isContainer = /^(class|interface|enum|struct|trait|impl|namespace|module|object|record)$/.test(kind);
      const inside = container && indent > container.indent ? container.name : undefined;
      out.push({ name: top[2], kind: kind === "fn" || kind === "func" ? "function" : kind, line, level: inside ? 1 : 0, text: clip(l), container: inside });
      if (isContainer) container = { name: top[2], indent };
      return;
    }
    if (container && indent > container.indent && indent <= container.indent + 8) {
      const m = BRACE_METHOD.exec(body);
      if (m && !BRACE_KEYWORD.test(m[1]) && !/^(return|throw|await|new|if|else)\b/.test(body) && !/[=!]=|=>\s*$/.test(body.split("(")[0])) {
        out.push({ name: m[1], kind: "method", line, level: 1, text: clip(l), container: container.name });
      }
    }
  });
  return out;
}

/** Symbol, uvnitř kterého leží řádek (poslední symbol začínající na něm nebo před ním). */
export function enclosingSymbol(syms: Sym[], line: number): Sym | undefined {
  let lo = 0;
  let hi = syms.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (syms[mid].line <= line) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? undefined : syms[found];
}

/**
 * Rozsah řádků definice: od řádku symbolu po řádek před dalším symbolem stejné nebo vyšší úrovně
 * (bez prázdných řádků na konci). Před definici se přiberou komentáře a dekorátory těsně nad ní.
 */
export function symbolRange(lines: string[], syms: Sym[], index: number): { from: number; to: number } {
  const s = syms[index];
  let end = lines.length;
  for (let k = index + 1; k < syms.length; k++) {
    if (syms[k].level <= s.level) {
      end = syms[k].line - 1;
      break;
    }
  }
  while (end > s.line && !lines[end - 1].trim()) end--;
  // komentář nebo dekorátor následující definice patří k ní, ne k této
  while (end > s.line && /^\s*(--|\/\/|#|\/\*\*?|\*\/?|@\w)/.test(lines[end - 1]) && end < lines.length) end--;
  while (end > s.line && !lines[end - 1].trim()) end--;
  let from = s.line;
  while (from > 1 && /^\s*(--|\/\/|#(?!\s*(include|define|if|end))|\/\*\*?|\*\/?|@\w)/.test(lines[from - 2])) from--;
  return { from, to: Math.max(end, s.line) };
}

/** Osnova: symboly jako řádky `L12  procedure vystav_fakturu(…)`, odsazené podle úrovně. */
export function renderOutline(syms: Sym[], max = 120): string {
  const shown = syms.slice(0, max);
  const out = shown.map((s) => `L${s.line}: ${"  ".repeat(Math.min(3, s.level))}${s.text}`);
  if (syms.length > max) out.push(`… (${syms.length - max} more)`);
  return out.join("\n");
}
