import * as path from "path";
import * as vscode from "vscode";
import { toLf } from "../tools/encoding";
import { cfg, CONFIG, workspaceFolders } from "../util";
import { WorkspaceIndex } from "./WorkspaceIndex";

/**
 * Index workspace ve VS Code: drží jednu instanci `WorkspaceIndex` pro otevřené složky, krmí ji
 * událostmi sledování souborů (vznik, změna, smazání), dodává neuložené texty z editoru a ukládá
 * index do úložiště rozšíření, takže po restartu se čtou jen změněné soubory.
 *
 * Vypnutí: nastavení `copyAgent.index.enabled`. Bez indexu nástroje čtou disk přímo jako dřív.
 */
export class IndexService implements vscode.Disposable {
  private current: WorkspaceIndex | undefined;
  private key = "";
  private readonly subs: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    /** složka úložiště rozšíření pro tento workspace (context.storageUri); bez ní se index neukládá */
    private readonly storageDir: string | undefined,
    private readonly log: (line: string) => void,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const touch = (uri: vscode.Uri) => {
      if (uri.scheme === "file") this.current?.touch(uri.fsPath);
    };
    this.subs.push(
      watcher,
      watcher.onDidCreate(touch),
      watcher.onDidChange(touch),
      watcher.onDidDelete(touch),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reset()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG}.index`)) this.reset();
        else if (e.affectsConfiguration("files.exclude")) this.current?.markStale();
      }),
    );
  }

  /** Index pro aktuální složky workspace; undefined, když je vypnutý nebo není otevřená žádná složka. */
  get index(): WorkspaceIndex | undefined {
    if (!cfg<boolean>("index.enabled", true)) {
      if (this.current) this.reset();
      return undefined;
    }
    const roots = workspaceFolders();
    if (!roots.length) return undefined;
    const key = roots.map((r) => `${r.name}=${r.fsPath}`).join("|");
    if (this.current && this.key === key) return this.current;
    void this.current?.dispose();
    this.key = key;
    this.current = new WorkspaceIndex({
      roots,
      excludes: () => this.excludedNames(),
      fallbackEncoding: () => cfg<string>("files.fallbackEncoding", "windows-1250"),
      unsaved: () => this.unsaved(),
      storageFile: this.storageDir ? path.join(this.storageDir, "index.bin") : undefined,
      cacheBytes: Math.max(8, cfg<number>("index.cacheMb", 96)) * 1024 * 1024,
      log: (l) => {
        this.log(l);
        this.emitter.fire();
      },
    });
    this.current.start();
    return this.current;
  }

  /** Zahodí index a postaví ho znovu (příkaz „Přestavět index“, změna nastavení nebo složek). */
  reset(rebuildFromScratch = false): void {
    const old = this.current;
    this.current = undefined;
    this.key = "";
    void old?.dispose();
    if (rebuildFromScratch && this.storageDir) {
      void vscode.workspace.fs.delete(vscode.Uri.file(path.join(this.storageDir, "index.bin"))).then(undefined, () => undefined);
    }
    this.emitter.fire();
  }

  /**
   * Názvy vynechané podle nastavení: jednoduché položky `files.exclude` (`**\/.git`, `**\/node_modules`)
   * a `copyAgent.index.exclude`. Složitější vzory se neberou (soubory pod nimi se jen indexují navíc).
   */
  private excludedNames(): string[] {
    const out: string[] = [...cfg<string[]>("index.exclude", [])];
    const files = vscode.workspace.getConfiguration("files").get<Record<string, boolean>>("exclude", {});
    for (const [pattern, on] of Object.entries(files)) {
      if (!on) continue;
      const name = pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
      if (name && !/[*?[{]/.test(name)) out.push(name);
    }
    return out;
  }

  /** Dokumenty s neuloženými změnami: jejich text má při hledání přednost před diskem. */
  private unsaved(): Map<string, string> {
    const out = new Map<string, string>();
    const index = this.current;
    if (!index) return out;
    for (const d of vscode.workspace.textDocuments) {
      if (!d.isDirty || d.uri.scheme !== "file") continue;
      const rel = index.relOf(d.uri.fsPath);
      if (rel) out.set(rel, toLf(d.getText()));
    }
    return out;
  }

  /** Stav pro uživatele (příkaz /index a panel). */
  describe(): string {
    const index = this.index;
    if (!index) return "Index workspace je vypnutý (nastavení copyAgent.index.enabled) nebo není otevřená žádná složka. Hledání a výpisy čtou disk přímo.";
    const s = index.stats();
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    return [
      `Index workspace: ${s.files} souborů, obsah přečten u ${s.indexed}${s.pending ? ` (zbývá ${s.pending}, čte se na pozadí)` : ""}.`,
      `Paměť: otisky ${mb(s.bloomBytes)} MB, mezipaměť obsahu ${mb(s.cacheBytes)} MB (strop ${cfg<number>("index.cacheMb", 96)} MB).`,
      `Od startu: ${s.diskReads} čtení z disku, ${s.cacheHits} z mezipaměti.`,
      "Přestavět od nuly: příkaz „Copy Agent: Přestavět index workspace“.",
    ].join("\n");
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    void this.current?.dispose();
    this.emitter.dispose();
  }
}
