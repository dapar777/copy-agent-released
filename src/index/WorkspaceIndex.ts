import * as fs from "fs";
import * as path from "path";
import { BINARY_EXT, DEFAULT_EXCLUDES, globToRegExp, parseGitignoreNames } from "../protocol/text";
import { decodeBytes, detectEncodingName, toLf } from "../tools/encoding";
import { extractSymbols, Sym } from "./symbols";
import { bloomHas, buildBloom, trigramsOf } from "./tokens";

/**
 * Index workspace: tabulka souborů (velikost, čas změny), u textových souborů otisk obsahu a symboly,
 * a mezipaměť obsahu souborů. Díky němu se soubory při hledání, výpisech a výběru kontextu nečtou
 * z disku pořád znovu:
 *
 *  - výpis souborů a globy jdou z tabulky v paměti (dřív průchod disku při každém dotazu);
 *  - hledání přečte jen soubory, které hledaný text podle otisku vůbec mohou obsahovat;
 *  - bajty jednou přečteného souboru zůstávají v paměti, dokud se soubor nezmění.
 *
 * Aktuálnost: po startu a po `markStale()` (příkaz mohl měnit soubory) se disk projde znovu a porovná
 * se velikost a čas změny každého souboru; hostitel navíc hlásí jednotlivé změny přes `touch()`
 * (sledování souborů ve VS Code, vlastní zápisy agenta). Otisky a symboly se počítají na pozadí
 * a ukládají se do souboru, takže po restartu se čtou jen změněné soubory.
 *
 * Čistý Node, bez `vscode`. Cesty jsou relativní stejně jako u Hosta: jedna složka bez předpony,
 * více složek s názvem složky na začátku.
 */

export interface IndexRoot {
  name: string;
  fsPath: string;
}

export interface IndexOptions {
  roots: IndexRoot[];
  /** další názvy vynechaných složek a souborů (nastavení files.exclude apod.) */
  excludes?: () => string[];
  fallbackEncoding?: () => string;
  /** neuložené texty z editoru (relativní cesta → text): mají přednost před diskem */
  unsaved?: () => Map<string, string>;
  /** soubor, do kterého se index ukládá mezi spuštěními */
  storageFile?: string;
  /** strop mezipaměti obsahu souborů v bajtech (výchozí 96 MB) */
  cacheBytes?: number;
  /**
   * Po kolika ms od posledního průchodu disku se index sám považuje za zastaralý. Výchozí nikdy: změny
   * hlásí hostitel (sledování souborů, `touch`, `markStale`). Hostitel bez sledování souborů dá 0.
   */
  maxAgeMs?: number;
  log?: (line: string) => void;
}

export interface IndexEntry {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  /** otisk trojic znaků (viz tokens.ts); undefined = soubor ještě čeká na přečtení */
  bloom?: Uint8Array;
  /** proč soubor nemá text (hledání ho přeskakuje) */
  skipped?: "binary" | "large" | "unreadable";
  symbols?: Sym[];
  lines?: number;
}

export interface IndexStats {
  files: number;
  /** soubory s přečteným obsahem (otisk, symboly) */
  indexed: number;
  pending: number;
  /** paměť otisků a mezipaměti obsahu v bajtech */
  bloomBytes: number;
  cacheBytes: number;
  building: boolean;
  /** kolikrát se četl soubor z disku / kolikrát stačila mezipaměť (od startu) */
  diskReads: number;
  cacheHits: number;
}

/** Soubor větší než tohle (v bajtech) se nečte vůbec. */
const MAX_BYTES = 2 * 1024 * 1024;
/** Stejná hranice, jakou má hledání: delší text se neprohledává. */
export const MAX_TEXT_CHARS = 512 * 1024;
const ALWAYS_EXCLUDED = [".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"];
const SLICE_MS = 8;
const READ_CONCURRENCY = 12;
const MAGIC = "CAIX3\n";

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Obsah souboru v mezipaměti: syrové bajty (mimo haldu JS) a název kódování; text se dekóduje při použití. */
interface CachedFile {
  buf: Buffer;
  encoding: string;
  size: number;
  mtimeMs: number;
  /** kolo hromadného čtení, ve kterém byl naposledy použit */
  gen: number;
}

export class WorkspaceIndex {
  private entries = new Map<string, IndexEntry>();
  private sorted: string[] | undefined;
  private cache = new Map<string, CachedFile>();
  private cacheSize = 0;
  private gen = 0;
  /** právě běžící čtení souborů (souběžné dotazy na týž soubor ho čtou jednou) */
  private loading = new Map<string, Promise<string | undefined>>();
  private stale = true;
  private verifiedAt = 0;
  private verifying: Promise<void> | undefined;
  /** soubory ohlášené přes touch() během běžícího průchodu disku */
  private touched: Set<string> | undefined;
  private deepening: Promise<void> | undefined;
  private pending = new Set<string>();
  private saveTimer: NodeJS.Timeout | undefined;
  private dirtySinceSave = false;
  private disposed = false;
  private diskReads = 0;
  private cacheHits = 0;
  private readonly maxCache: number;

  constructor(private readonly opts: IndexOptions) {
    this.maxCache = opts.cacheBytes ?? 96 * 1024 * 1024;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private get multi(): boolean {
    return this.opts.roots.length > 1;
  }

  // ---------- životní cyklus ----------

  private loaded = false;

  /** Na pozadí načte uložený index (když je) a srovná ho s diskem. */
  start(): void {
    void this.ensureFresh().catch((e) => this.log(`index: ${(e as Error).message}`));
  }

  /** Soubory se mohly změnit mimo dohled (doběhl příkaz, začíná úkol): příští dotaz si disk projde znovu. */
  markStale(): void {
    this.stale = true;
  }

  private settleUntil = 0;
  private background: Promise<void> | undefined;

  /**
   * Právě doběhlo něco, co mohlo měnit soubory (příkaz), a změny hlásí sledování souborů: další dotaz
   * chvíli počká, než jeho události dorazí. Levnější než procházet celý disk po každém příkazu.
   */
  settle(ms = 300): void {
    this.settleUntil = Math.max(this.settleUntil, Date.now() + ms);
  }

  /**
   * Projde disk na pozadí, aniž by na to dotazy čekaly: pojistka pro změny, které nikdo neohlásil
   * (sledování souborů něco propustilo, soubory se změnily jinou cestou).
   */
  refreshInBackground(): void {
    if (this.verifying || this.background || this.stale || !this.loaded || this.disposed) return;
    this.background = this.verify()
      .catch((e) => this.log(`index: ${(e as Error).message}`))
      .finally(() => {
        this.background = undefined;
        this.verifiedAt = Date.now();
      });
  }

  /** Zajistí, že tabulka souborů odpovídá disku. Běžící průchod se sdílí. */
  async ensureFresh(): Promise<void> {
    const wait = this.settleUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 1000)));
    if (this.verifying) return this.verifying;
    if (!this.stale && Date.now() - this.verifiedAt <= (this.opts.maxAgeMs ?? Infinity)) return;
    this.stale = false;
    if (!this.loaded) {
      // uložený index z minula: srovnání s diskem pak čte jen soubory, které se od té doby změnily
      this.loaded = true;
      this.load();
    }
    const prior = this.background;
    this.verifying = (async () => {
      if (prior) await prior;
      await this.verify();
    })().finally(() => {
      this.verifying = undefined;
      this.verifiedAt = Date.now();
    });
    return this.verifying;
  }

  /** Počká, až budou přečtené všechny soubory (otisky, symboly). false = do limitu se to nestihlo. */
  async whenDeep(timeoutMs = 60_000): Promise<boolean> {
    await this.ensureFresh();
    const until = Date.now() + timeoutMs;
    while (this.pending.size) {
      if (Date.now() > until) return false;
      await (this.deepening ?? this.deepen());
    }
    return true;
  }

  stats(): IndexStats {
    let indexed = 0;
    let bloomBytes = 0;
    for (const e of this.entries.values()) {
      if (e.bloom || e.skipped) indexed++;
      bloomBytes += e.bloom?.length ?? 0;
    }
    return { files: this.entries.size, indexed, pending: this.pending.size, bloomBytes, cacheBytes: this.cacheSize, building: !!this.verifying || !!this.deepening, diskReads: this.diskReads, cacheHits: this.cacheHits };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.dirtySinceSave) this.save();
  }

  // ---------- tabulka souborů ----------

  private excludeCache = new Map<string, { at: number; names: Set<string> }>();

  /** Vynechané názvy pro kořen: výchozí, z nastavení a jednoduché položky .gitignore (pár sekund v paměti). */
  private excludedNames(root: IndexRoot): Set<string> {
    const hit = this.excludeCache.get(root.fsPath);
    if (hit && Date.now() - hit.at < 5000) return hit.names;
    const names = new Set([...DEFAULT_EXCLUDES, ...ALWAYS_EXCLUDED, ...(this.opts.excludes?.() ?? [])]);
    try {
      for (const n of parseGitignoreNames(fs.readFileSync(path.join(root.fsPath, ".gitignore"), "utf8"))) names.add(n);
    } catch {
      /* bez .gitignore */
    }
    this.excludeCache.set(root.fsPath, { at: Date.now(), names });
    return names;
  }

  /** Projde disk (po kouscích, aby neblokoval) a srovná tabulku: nové, změněné a smazané soubory. */
  private async verify(): Promise<void> {
    const started = Date.now();
    const seen = new Set<string>();
    this.touched = new Set();
    this.excludeCache.clear();
    let added = 0;
    let changed = 0;
    let slice = Date.now();
    for (const root of this.opts.roots) {
      const ignore = this.excludedNames(root);
      const stack: { abs: string; rel: string }[] = [{ abs: root.fsPath, rel: "" }];
      while (stack.length) {
        const dir = stack.pop()!;
        let list: fs.Dirent[];
        try {
          list = fs.readdirSync(dir.abs, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of list) {
          const inner = dir.rel ? `${dir.rel}/${e.name}` : e.name;
          if (ignore.has(e.name) || ignore.has(inner)) continue;
          if (e.isDirectory()) {
            stack.push({ abs: path.join(dir.abs, e.name), rel: inner });
            continue;
          }
          if (!e.isFile()) continue;
          const abs = path.join(dir.abs, e.name);
          let st: fs.Stats | undefined;
          try {
            st = fs.statSync(abs);
          } catch {
            continue;
          }
          const rel = this.multi ? `${root.name}/${inner}` : inner;
          seen.add(rel);
          const old = this.entries.get(rel);
          if (!old) {
            this.entries.set(rel, { rel, abs, size: st.size, mtimeMs: st.mtimeMs });
            this.pending.add(rel);
            this.sorted = undefined;
            added++;
          } else if (old.size !== st.size || old.mtimeMs !== st.mtimeMs || old.abs !== abs) {
            this.entries.set(rel, { rel, abs, size: st.size, mtimeMs: st.mtimeMs });
            this.pending.add(rel);
            changed++;
          } else if (!old.bloom && !old.skipped) this.pending.add(rel);
          if (Date.now() - slice > SLICE_MS) {
            await yieldToLoop();
            slice = Date.now();
          }
        }
      }
    }
    let removed = 0;
    // soubor ohlášený během průchodu (vznikl, až když byla jeho složka projitá) se nemaže
    const touched = this.touched ?? new Set<string>();
    this.touched = undefined;
    for (const rel of [...this.entries.keys()]) {
      if (seen.has(rel) || touched.has(rel)) continue;
      this.drop(rel);
      removed++;
    }
    if (added || changed || removed) this.dirtySinceSave = true;
    this.log(`index: ${this.entries.size} souborů za ${Date.now() - started} ms (nových ${added}, změněných ${changed}, smazaných ${removed}); ke čtení ${this.pending.size}`);
    if (this.pending.size) void this.deepen();
  }

  private drop(rel: string): void {
    const e = this.entries.get(rel);
    if (!e) return;
    this.entries.delete(rel);
    this.pending.delete(rel);
    this.sorted = undefined;
    this.uncache(rel);
    this.dirtySinceSave = true;
  }

  /** Relativní cesta podle absolutní (pro události sledování souborů); undefined mimo kořeny. */
  relOf(abs: string): string | undefined {
    for (const root of this.opts.roots) {
      const inner = path.relative(root.fsPath, abs);
      if (!inner || inner.startsWith("..") || path.isAbsolute(inner)) continue;
      const posix = inner.split(path.sep).join("/");
      return this.multi ? `${root.name}/${posix}` : posix;
    }
    return undefined;
  }

  private absOf(rel: string): string | undefined {
    if (!this.multi) return this.opts.roots[0] ? path.join(this.opts.roots[0].fsPath, rel) : undefined;
    const slash = rel.indexOf("/");
    const root = this.opts.roots.find((r) => r.name === (slash < 0 ? rel : rel.slice(0, slash)));
    return root && slash >= 0 ? path.join(root.fsPath, rel.slice(slash + 1)) : undefined;
  }

  private isExcluded(rel: string): boolean {
    const inner = this.multi ? rel.slice(rel.indexOf("/") + 1) : rel;
    const root = this.multi ? this.opts.roots.find((r) => rel.startsWith(r.name + "/")) : this.opts.roots[0];
    if (!root) return true;
    const names = this.excludedNames(root);
    const parts = inner.split("/");
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      if (names.has(p) || names.has(acc)) return true;
    }
    return false;
  }

  /**
   * Soubor se změnil, vznikl nebo zmizel (hlásí sledování souborů a vlastní zápisy agenta). Když jde
   * o složku, projde se disk celý.
   */
  touch(relOrAbs: string): void {
    const rel = path.isAbsolute(relOrAbs) ? this.relOf(relOrAbs) : relOrAbs.replace(/\\/g, "/");
    if (!rel || rel.startsWith("~")) return;
    const abs = this.absOf(rel);
    if (!abs) return;
    this.touched?.add(rel);
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(abs);
    } catch {
      st = undefined;
    }
    if (!st) {
      // smazaný soubor, nebo celá složka
      if (this.entries.has(rel)) this.drop(rel);
      else {
        const prefix = rel + "/";
        for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.drop(k);
      }
      return;
    }
    if (st.isDirectory()) {
      this.markStale();
      return;
    }
    if (!st.isFile() || this.isExcluded(rel)) return;
    const old = this.entries.get(rel);
    if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) return;
    if (!old) this.sorted = undefined;
    this.entries.set(rel, { rel, abs, size: st.size, mtimeMs: st.mtimeMs });
    this.pending.add(rel);
    this.dirtySinceSave = true;
    this.scheduleDeepen();
  }

  private deepenTimer: NodeJS.Timeout | undefined;
  private scheduleDeepen(): void {
    if (this.deepenTimer || this.disposed) return;
    this.deepenTimer = setTimeout(() => {
      this.deepenTimer = undefined;
      void this.deepen();
    }, 150);
  }

  /** Seřazené relativní cesty všech souborů. */
  async list(): Promise<string[]> {
    await this.ensureFresh();
    return (this.sorted ??= [...this.entries.keys()].sort());
  }

  /** Soubory odpovídající globu (v multi-root workspace glob začíná názvem složky, nebo platí pro všechny). */
  async match(glob: string, max = Infinity): Promise<string[]> {
    const all = await this.list();
    if (glob === "**/*" || glob === "**") return all.slice(0, max);
    const g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    let res: RegExp[];
    if (!this.multi) res = [globToRegExp(g)];
    else {
      // glob začínající názvem složky platí v ní; jiný se zkusí v každé složce workspace
      const named = this.opts.roots.find((r) => g === r.name || g.startsWith(r.name + "/"));
      res = named ? [globToRegExp(g === named.name ? `${g}/**/*` : g)] : this.opts.roots.map((r) => globToRegExp(`${r.name}/${g}`));
    }
    const out: string[] = [];
    for (const f of all) {
      if (res.some((re) => re.test(f))) {
        out.push(f);
        if (out.length >= max) break;
      }
    }
    return out;
  }

  has(rel: string): boolean {
    return this.entries.has(rel);
  }

  entry(rel: string): IndexEntry | undefined {
    return this.entries.get(rel);
  }

  /** Soubor má text, který jde prohledávat (není binární ani příliš velký). */
  searchable(rel: string): boolean {
    const e = this.entries.get(rel);
    return !!e && !e.skipped && e.size <= MAX_BYTES && !BINARY_EXT.test(rel);
  }

  // ---------- obsah ----------

  private uncache(rel: string): void {
    const c = this.cache.get(rel);
    if (!c) return;
    this.cacheSize -= c.buf.length;
    this.cache.delete(rel);
  }

  /**
   * Uloží bajty souboru do mezipaměti. Když je plná, uvolní se nejdéle nepoužité soubory, ale jen ty
   * z dřívějších kol hromadného čtení: jinak by si postupné čtení všech souborů mazalo právě to, co
   * za chvíli potřebuje. Když se nevejde, nový soubor se prostě neuloží.
   */
  private remember(rel: string, e: IndexEntry, buf: Buffer, encoding: string): void {
    this.uncache(rel);
    if (buf.length > this.maxCache / 8) return;
    if (this.cacheSize + buf.length > this.maxCache) {
      for (const [k, v] of this.cache) {
        if (this.cacheSize + buf.length <= this.maxCache) break;
        if (v.gen === this.gen) break; // dál už jsou jen soubory použité v tomto kole
        this.cache.delete(k);
        this.cacheSize -= v.buf.length;
      }
      if (this.cacheSize + buf.length > this.maxCache) return;
    }
    this.cache.set(rel, { buf, encoding, size: e.size, mtimeMs: e.mtimeMs, gen: this.gen });
    this.cacheSize += buf.length;
  }

  /** Zapíše k souboru otisk obsahu, symboly a počet řádků. */
  private digest(e: IndexEntry, text: string): void {
    e.bloom = buildBloom(text);
    e.symbols = extractSymbols(text, e.rel);
    let lines = 1;
    for (let k = text.indexOf("\n"); k >= 0; k = text.indexOf("\n", k + 1)) lines++;
    e.lines = lines;
    this.pending.delete(e.rel);
    this.dirtySinceSave = true;
  }

  private decode(buf: Buffer, encoding: string): string {
    return toLf(decodeBytes(buf, encoding));
  }

  /** Přečte soubor z disku, dekóduje ho a zapíše do indexu. undefined = binární, velký nebo nečitelný. */
  private async load1(e: IndexEntry, keep: boolean): Promise<string | undefined> {
    const skip = (why: IndexEntry["skipped"]): undefined => {
      e.skipped = why;
      e.bloom = undefined;
      this.pending.delete(e.rel);
      return undefined;
    };
    if (BINARY_EXT.test(e.rel)) return skip("binary");
    if (e.size > MAX_BYTES) return skip("large");
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(e.abs);
      this.diskReads++;
    } catch {
      return skip("unreadable");
    }
    const encoding = detectEncodingName(buf, this.opts.fallbackEncoding?.() ?? "windows-1250");
    const text = this.decode(buf, encoding);
    // soubor byl během čtení ohlášen jako změněný: tabulka už má nový záznam, tenhle text patří starému
    if (this.entries.get(e.rel) !== e) return text.length > MAX_TEXT_CHARS || text.includes("\u0000") ? undefined : text;
    if (text.length > MAX_TEXT_CHARS) return skip("large");
    if (text.includes("\u0000")) return skip("binary");
    e.skipped = undefined;
    // soubor se mezitím mohl změnit: velikost z přečtených bajtů je spolehlivější než z tabulky
    if (buf.length !== e.size) e.size = buf.length;
    if (!e.bloom || this.pending.has(e.rel)) this.digest(e, text);
    if (keep) this.remember(e.rel, e, buf, encoding);
    return text;
  }

  /**
   * Text souboru (LF). Bajty zůstávají v mezipaměti, dokud se soubor nezmění. undefined = soubor není
   * v indexu, je binární, příliš velký nebo nejde přečíst. Neuložený text z editoru má přednost.
   */
  async text(rel: string, unsaved?: Map<string, string>): Promise<string | undefined> {
    const live = (unsaved ?? this.opts.unsaved?.())?.get(rel);
    if (live !== undefined) return live;
    const e = this.entries.get(rel);
    if (!e || e.skipped) return undefined;
    const hit = this.cache.get(rel);
    if (hit && hit.size === e.size && hit.mtimeMs === e.mtimeMs) {
      this.cacheHits++;
      hit.gen = this.gen;
      this.cache.delete(rel);
      this.cache.set(rel, hit);
      const text = this.decode(hit.buf, hit.encoding);
      if (!e.bloom) this.digest(e, text);
      return text;
    }
    const running = this.loading.get(rel);
    if (running) return running;
    const p = this.load1(e, true).finally(() => this.loading.delete(rel));
    this.loading.set(rel, p);
    return p;
  }

  /** Neuložené texty z editoru (cesta → text). */
  unsavedTexts(): Map<string, string> {
    return this.opts.unsaved?.() ?? new Map();
  }

  /** Texty více souborů souběžně, v pořadí cest. `each` vrátí false, když už další nechce. */
  async eachText(rels: string[], each: (rel: string, text: string | undefined) => boolean | void, concurrency = READ_CONCURRENCY * 2): Promise<void> {
    const unsaved = this.opts.unsaved?.();
    this.gen++;
    for (let i = 0; i < rels.length; i += concurrency) {
      const batch = rels.slice(i, i + concurrency);
      const got = await Promise.all(batch.map((r) => this.text(r, unsaved)));
      for (let k = 0; k < batch.length; k++) if (each(batch[k], got[k]) === false) return;
      // dlouhé čtení z mezipaměti by jinak nepustilo ke slovu nic jiného
      if (i % (concurrency * 8) === 0) await yieldToLoop();
    }
  }

  /** Na pozadí přečte soubory, které ještě nemají otisk (po startu, po změnách). */
  private async deepen(): Promise<void> {
    if (this.deepening) return this.deepening;
    const run = async () => {
      const started = Date.now();
      let n = 0;
      while (this.pending.size && !this.disposed) {
        const batch: IndexEntry[] = [];
        for (const rel of this.pending) {
          const e = this.entries.get(rel);
          if (e) batch.push(e);
          else this.pending.delete(rel);
          if (batch.length >= READ_CONCURRENCY) break;
        }
        if (!batch.length) break;
        // obsah si rovnou necháme, dokud je v mezipaměti místo: první hledání po startu už nic nečte
        await Promise.all(batch.map((e) => this.loading.get(e.rel) ?? this.load1(e, this.cacheSize + e.size <= this.maxCache * 0.9)));
        n += batch.length;
        await yieldToLoop();
      }
      if (n > 50) this.log(`index: přečteno ${n} souborů za ${Date.now() - started} ms`);
      this.saveSoon();
    };
    this.deepening = run().finally(() => (this.deepening = undefined));
    return this.deepening;
  }

  // ---------- předvýběr podle otisku ----------

  /**
   * Soubory z `among`, které mohou obsahovat shodu: `branches` je seznam větví (stačí jedna), větev je
   * seznam doslovných kusů, které musí být všechny v souboru. Soubor, který ještě nemá otisk, se vrací
   * vždy (nic se nezamlčí).
   */
  candidates(branches: string[][], among: string[]): string[] {
    const prepared = branches.map((frags) => frags.map((f) => trigramsOf(f)));
    const out: string[] = [];
    for (const rel of among) {
      const e = this.entries.get(rel);
      if (!e || e.skipped) continue;
      const bloom = e.bloom;
      if (!bloom || this.pending.has(rel)) {
        out.push(rel);
        continue;
      }
      if (prepared.some((frags) => frags.every((t) => bloomHas(bloom, t)))) out.push(rel);
    }
    return out;
  }

  // ---------- symboly ----------

  /** Symboly souboru (soubor se přečte, když ještě nebyl). */
  async symbolsOf(rel: string): Promise<Sym[]> {
    const e = this.entries.get(rel);
    if (!e || e.skipped) return [];
    if (!e.symbols) await this.text(rel);
    return e.symbols ?? [];
  }

  /** Všechny symboly přečtených souborů: [soubor, symbol]. */
  *allSymbols(): Generator<[string, Sym]> {
    for (const rel of this.sorted ?? [...this.entries.keys()].sort()) {
      const e = this.entries.get(rel);
      for (const s of e?.symbols ?? []) yield [rel, s];
    }
  }

  // ---------- uložení mezi spuštěními ----------

  private rootsKey(): string {
    return this.opts.roots.map((r) => `${r.name}=${r.fsPath}`).join("|");
  }

  private saveSoon(): void {
    if (!this.opts.storageFile || this.saveTimer || this.disposed || !this.dirtySinceSave) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 4000);
  }

  /** Uloží tabulku souborů, otisky a symboly (obsah souborů ne). */
  save(): void {
    const file = this.opts.storageFile;
    if (!file) return;
    try {
      const files: unknown[] = [];
      const blooms: Uint8Array[] = [];
      let at = 0;
      for (const e of this.entries.values()) {
        if ((!e.bloom && !e.skipped) || this.pending.has(e.rel)) continue; // nepřečtený soubor se přečte příště
        const n = e.bloom?.length ?? 0;
        if (e.bloom) blooms.push(e.bloom);
        files.push([e.rel, e.size, e.mtimeMs, at, n, e.skipped ?? "", e.lines ?? 0, (e.symbols ?? []).map((s) => [s.name, s.kind, s.line, s.level, s.text, s.container ?? ""])]);
        at += n;
      }
      const meta = Buffer.from(JSON.stringify({ roots: this.rootsKey(), files }), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32LE(meta.length, 0);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([Buffer.from(MAGIC, "latin1"), head, meta, ...blooms]));
      fs.renameSync(tmp, file);
      this.dirtySinceSave = false;
      this.log(`index: uložen (${files.length} souborů, ${Math.round((meta.length + at) / 1024)} kB)`);
    } catch (e) {
      this.log(`index: uložení selhalo: ${(e as Error).message}`);
    }
  }

  /** Načte uložený index. Co se od uložení změnilo, pozná následné srovnání s diskem. */
  private load(): void {
    const file = this.opts.storageFile;
    if (!file) return;
    try {
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, MAGIC.length).toString("latin1") !== MAGIC) return;
      const metaLen = buf.readUInt32LE(MAGIC.length);
      const metaStart = MAGIC.length + 4;
      const meta = JSON.parse(buf.subarray(metaStart, metaStart + metaLen).toString("utf8")) as { roots: string; files: [string, number, number, number, number, string, number, [string, string, number, number, string, string][]][] };
      if (meta.roots !== this.rootsKey()) return;
      const bodyStart = metaStart + metaLen;
      for (const [rel, size, mtimeMs, at, n, skipped, lines, symbols] of meta.files) {
        const abs = this.absOf(rel);
        if (!abs) continue;
        const e: IndexEntry = { rel, abs, size, mtimeMs };
        if (skipped) e.skipped = skipped as IndexEntry["skipped"];
        else {
          // kopie, ať otisky nedrží v paměti celý načtený soubor
          e.bloom = new Uint8Array(buf.subarray(bodyStart + at, bodyStart + at + n));
          e.lines = lines;
          e.symbols = symbols.map(([name, kind, line, level, text, container]) => ({ name, kind, line, level, text, container: container || undefined }));
        }
        this.entries.set(rel, e);
      }
      this.sorted = undefined;
      this.log(`index: načten uložený (${this.entries.size} souborů)`);
    } catch {
      /* žádný nebo poškozený soubor: index se postaví znovu */
    }
  }
}
