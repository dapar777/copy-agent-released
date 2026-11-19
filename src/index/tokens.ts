/**
 * Otisk obsahu souboru pro předvýběr při hledání.
 *
 * Index si u každého souboru pamatuje malý otisk (Bloomův filtr) všech trojic sousedních znaků
 * v řádcích. Z regulárního výrazu se vytáhnou kusy textu, které ve shodě být MUSÍ; soubor, kterému
 * v otisku chybí některá trojice takového kusu, shodu mít nemůže a vůbec se nečte. Otisk může říct
 * „možná“ i u souboru bez shody (ten se pak přečte zbytečně), ale nikdy neřekne „ne“ u souboru se
 * shodou. Vše je tu opatrné: výraz, který nejde bezpečně rozebrat, znamená prohledat všechno.
 *
 * Znaky se před otiskem sjednotí stejně, jak porovnává hledání bez ohledu na velikost písmen:
 * písmena A–Z na malá, každý znak mimo ASCII na jeden zástupný (velké i malé „č“ tak dá totéž).
 */

export const MIN_FRAGMENT = 3;
const MIN_BITS = 1024;
const MAX_BITS = 1 << 22;
const NON_ASCII = 128;

function hashBit(a: number, b: number, c: number, mask: number): number {
  return ((Math.imul((a << 16) ^ (b << 8) ^ c, 0x9e3779b1) >>> 0) >>> 7) & mask;
}

/** Otisk textu: velikost roste s délkou textu (bitů je aspoň polovina počtu znaků, mocnina dvou). */
export function buildBloom(text: string): Uint8Array {
  const n = text.length;
  let bits = MIN_BITS;
  while (bits < n / 2 && bits < MAX_BITS) bits <<= 1;
  const bloom = new Uint8Array(bits >> 3);
  const mask = bits - 1;
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    let c = text.charCodeAt(i);
    if (c === 10) {
      a = 0;
      b = 0;
      continue;
    }
    if (c >= NON_ASCII) c = NON_ASCII;
    else if (c >= 65 && c <= 90) c += 32;
    if (a !== 0 && b !== 0) {
      const bit = hashBit(a, b, c, mask);
      bloom[bit >> 3] |= 1 << (bit & 7);
    }
    a = b;
    b = c;
  }
  return bloom;
}

/** Trojice kusu textu připravené pro dotaz do otisků (každá jako [a, b, c] po sjednocení znaků). */
export function trigramsOf(fragment: string): number[][] {
  const out: number[][] = [];
  let a = 0;
  let b = 0;
  for (let i = 0; i < fragment.length; i++) {
    let c = fragment.charCodeAt(i);
    if (c === 10) {
      a = 0;
      b = 0;
      continue;
    }
    if (c >= NON_ASCII) c = NON_ASCII;
    else if (c >= 65 && c <= 90) c += 32;
    if (a !== 0 && b !== 0) out.push([a, b, c]);
    a = b;
    b = c;
  }
  return out;
}

/** Může soubor s tímto otiskem obsahovat všechny dané trojice? */
export function bloomHas(bloom: Uint8Array, trigrams: number[][]): boolean {
  const mask = bloom.length * 8 - 1;
  for (const [a, b, c] of trigrams) {
    const bit = hashBit(a, b, c, mask);
    if (!(bloom[bit >> 3] & (1 << (bit & 7)))) return false;
  }
  return true;
}

/** Rozdělí výraz na větve nejvyšší úrovně (`a|b|c`); null, když je výraz neuzavřený. */
function topLevelBranches(pattern: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) {
      out.push(pattern.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) return null;
  }
  if (depth !== 0 || inClass) return null;
  out.push(pattern.slice(start));
  return out;
}

/** Doslovné běhy jedné větve: text, který ve shodě být musí (skupiny, třídy a nepovinné znaky běh ukončí). */
export function literalRuns(branch: string): string[] {
  const runs: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) runs.push(cur);
    cur = "";
  };
  for (let i = 0; i < branch.length; i++) {
    const ch = branch[i];
    if (ch === "\\") {
      const next = branch[i + 1];
      i++;
      if (next === undefined) break;
      // třídy, hranice, zpětné odkazy a řídicí znaky nejsou doslovný text; ostatní escapované znaky ano
      if (/[dDwWsSbBnrtfv0-9kpPuxc]/.test(next)) {
        flush();
        if (branch[i + 1] === "{" || branch[i + 1] === "<") {
          // \p{…}, \u{…}, \k<name>: přeskočit argument
          const close = branch.indexOf(branch[i + 1] === "{" ? "}" : ">", i + 1);
          i = close < 0 ? branch.length : close;
        } else i += next === "u" ? 4 : next === "x" ? 2 : next === "c" ? 1 : 0;
        continue;
      }
      cur += next;
      continue;
    }
    if (ch === "[") {
      flush();
      let j = i + 1;
      if (branch[j] === "^") j++;
      if (branch[j] === "]") j++;
      while (j < branch.length && branch[j] !== "]") j += branch[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === "(") {
      // skupina: její obsah se pro jistotu nepočítá (může být nepovinná nebo mít větve)
      flush();
      let depth = 1;
      let j = i + 1;
      let inClass = false;
      while (j < branch.length && depth > 0) {
        const c = branch[j];
        if (c === "\\") j++;
        else if (inClass) inClass = c !== "]";
        else if (c === "[") inClass = true;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        j++;
      }
      i = j - 1;
      continue;
    }
    if (ch === "?" || ch === "*") {
      // předchozí znak je nepovinný
      cur = cur.slice(0, -1);
      flush();
      continue;
    }
    if (ch === "{") {
      const close = branch.indexOf("}", i);
      const body = close < 0 ? "" : branch.slice(i + 1, close);
      if (/^\d+(,\d*)?$/.test(body)) {
        if (/^0/.test(body)) cur = cur.slice(0, -1);
        flush();
        i = close;
        continue;
      }
      cur += ch; // doslovná složená závorka
      continue;
    }
    if (ch === "+" || ch === "." || ch === "^" || ch === "$" || ch === ")") {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return runs;
}

/**
 * Co musí soubor obsahovat, aby v něm výraz mohl najít shodu: seznam větví (stačí jedna), každá větev
 * je seznam doslovných kusů (aspoň 3 znaky), které musí být všechny v některém řádku souboru.
 * null = nejde bezpečně určit (některá větev nemá použitelný kus), prohledat se musí všechno.
 */
export function requiredFragments(pattern: string): string[][] | null {
  const branches = topLevelBranches(pattern);
  if (!branches) return null;
  const out: string[][] = [];
  for (const b of branches) {
    const frags = [...new Set(literalRuns(b).filter((r) => r.length >= MIN_FRAGMENT && !r.includes("\n")))];
    if (!frags.length) return null;
    // nejdelší kusy vybírají nejlíp; víc než tři už nic nepřidají
    out.push(frags.sort((a, c) => c.length - a.length).slice(0, 3));
  }
  return out.length ? out : null;
}
