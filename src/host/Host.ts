import type { WorkspaceIndex } from "../index/WorkspaceIndex";
import { FileEncoding } from "../tools/encoding";

/**
 * Rozhraní k prostředí, ve kterém agent běží. Implementace: VsCodeHost (extension) a NodeHost
 * (headless CLI / testy). Nástroje pracují jen s ním.
 */

export interface RunResult {
  output: string;
  exit: number;
  timedOut: boolean;
  /** probe režim: proces po uplynutí probeMs stále běžel (a byl ukončen) */
  stillRunning?: boolean;
  interrupted?: boolean;
  /** aktivní doba běhu (bez doby, kdy byl počítač uspaný) */
  durationMs: number;
  suspendedMs?: number;
}

export interface HostPolicy {
  autoAllow: string[];
  allowPatterns?: string[];
  deny: string[];
  protectedPaths: string[];
  /** PowerShell spouštěný z <run> dostane -NoProfile -NonInteractive (rychlejší start); výchozí ano */
  powershellNoProfile?: boolean;
}

export interface Host {
  readonly workspaceName: string;
  /** složky workspace; víc než jedna = multi-root */
  readonly folders: { name: string; path: string }[];
  readonly policy: HostPolicy;
  /** index workspace: rychlé výpisy souborů, hledání přes slova, symboly; bez něj nástroje čtou disk přímo */
  readonly index?: WorkspaceIndex;

  assertInside(rel: string): void;
  /** Kanonický tvar cesty (relativní k workspace, nebo `~/.copy-agent/…`); vyhodí chybu pro cestu mimo. */
  canonical(rel: string): string;
  exists(rel: string): Promise<boolean>;
  /** Obsah souboru; kódování se pozná z bajtů, konce řádků se sjednotí na LF. */
  readFile(rel: string): Promise<string>;
  /** Zápis; u existujícího souboru se zachová jeho kódování, BOM i konce řádků. */
  writeFile(rel: string, text: string): Promise<void>;
  fileEncoding(rel: string): Promise<FileEncoding>;
  appendFile(rel: string, text: string): Promise<void>;
  deleteFile(rel: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  /** Relativní cesty souborů (posix oddělovače), seřazené, bez ignorovaných adresářů. */
  listFiles(glob: string, max?: number): Promise<string[]>;
  run(command: string, cwdRel: string, timeoutMs: number, probeMs?: number, signal?: AbortSignal): Promise<RunResult>;
  /** Textový výpis chyb/varování; prázdný řetězec, když nic není nebo není k dispozici. */
  diagnostics(onlyRel?: string): Promise<string>;
  /**
   * Diagnostika po změně souborů: počká, až ji jazykové servery přepočítají (jen tak dlouho, jak je
   * potřeba). Host, který to neumí, ji nemá a volající počká pevnou dobu.
   */
  diagnosticsSettled?(onlyRel?: string): Promise<string>;
  screenshot(rel: string, opts: { window?: string }): Promise<{ width: number; height: number; window?: string }>;
  absolutePath(rel: string): string;
  confirmCommand(command: string, cwdRel: string): Promise<boolean>;
  confirmDelete(rel: string): Promise<boolean>;
  log(line: string): void;
}
