# Copy Agent – návrh

Copy Agent je kódovací agent pro VS Code, který s modelem komunikuje přes schránku. Vychází
z whisper-agentu, ale je navržený znovu kolem jednoho cíle: **Copilot v Teams s vlastním agentem**
a **co nejméně interakcí uživatele** na úkol.

## 1. Co se oproti whisper-agentu změnilo a proč

| Oblast | whisper-agent | Copy Agent |
|---|---|---|
| Protokol pro model | celá preambule v každém prvním promptu | protokol je v **instrukcích agenta** v Copilotu (generované ze zdrojů, ≤ 8 000 znaků); první prompt nese jen kontext a zadání (`copyAgent.target = copilot-agent`); obecný chat dál dostane celou preambuli (`generic`) |
| Blok odpovědi | bez ohrazení (claude.ai) | **vždy v ohrazení čtyř zpětných apostrofů**: Teams nic neskryje, tlačítko *Kopírovat* dá přesný text, vnitřní ``` nic nerozbijí; parser zvládne i ohrazení rozbité renderováním |
| Kontext | model si soubory vyžádá (bundle na vyžádání, volitelně full bundle) | **celá codebase jako jeden .txt k prvnímu promptu** (výchozí, do limitu velikosti), jinak **automatický výběr souborů** podle zadání (cesty, identifikátory, aktivní soubor, osnovy a okolí shod) |
| Limity chatu | jeden limit promptu, dlouhé výsledky se odloží | **dělení promptu na části** `[PART i/n]` (model na části odpoví „OK“), **vícedílné odpovědi** `part="i/n"`, **useknutá odpověď** = hotové akce proběhnou, model dostane přesný seznam, co poslat znovu |
| Doručení do chatu | text, historie schránky, soubory, drag & drop přes pywin32 | **kroky doručení**: části textu, pak přílohy jako soubory ve schránce (Windows); po vložení textu se další krok zkopíruje sám; žádný Python |
| Kola | 2–5 kol na úkol, revize před dokončením vždy | pravidlo „**co nejméně odpovědí, ideálně jedna**“ (edity + testy + done v jedné odpovědi, otázky jen když je model blokovaný), revize před dokončením vypnutá (`off`/`auto`/`always`) |
| Provádění akcí | sekvenčně | čtecí akce (read, grep, ls, glob, bundle, diagnostics) **souběžně**, grep v dávkách, seznam souborů v cache |
| Schránka | text přes vlastníka s odloženým vykreslením (PowerShell) | text **hned** přes VS Code API, vlastník (detekce vložení) běží vedle a nezdržuje; po návratu fokusu do VS Code se schránka přečte ihned |
| Panel | plné překreslení proudu | přírůstkové vykreslení, kroky doručení s ukazatelem, tlačítko *Další krok*, přepínač cíle chatu |
| Instrukce projektu | `WHISPER.md` | `AGENTS.md` (standard napříč nástroji), fallback `COPY-AGENT.md`; stav v `.copy-agent/`, globálně `~/.copy-agent/` |
| Nástroje | read, ls, glob, grep, bundle, write, edit, delete, run, screenshot, diagnostics, ask, status, dialog, plan, suggest, done | totéž + `move`; `read` vrací osnovu včetně metod tříd |

Převzaté a ověřené části (s úpravami): SEARCH/REPLACE hunky s tolerancemi, sekce markdownu, řádkový
diff a review změn s CodeLens, kódování souborů, kontrola zapsaných souborů, hooky, skilly, návrhy,
transkript, git checkpoint, záchrany dokumentu z chatu, headless harness.

## 2. Pracovní tok s Copilotem v Teams

```
VS Code (panel)                    schránka                     Copilot v Teams (agent Copy Agent)
──────────────                     ────────                     ──────────────────────────────────
zadání ──► prompt (kontext+úkol) ─► text ──────────────────────► Ctrl+V (části: „OK“ … LAST)
           codebase.txt ──────────► soubor (po vložení textu) ──► Ctrl+V = příloha, Enter
                                                               ◄─ odpověď: ````<copy turn="1">…</copy>````
akce (edit, run, diagnostics) ◄── schránka ◄──────────────────── klik „Kopírovat“ u bloku
výsledky ──► další prompt ────────► text ──────────────────────► Ctrl+V … dokud nepřijde <done>
```

Ideální průběh je **jedna odpověď**: model má celou codebase, udělá úpravy, spustí testy a pošle
`<done>` v jednom bloku. Rozšíření pak jen zobrazí výsledky a změny ke schválení.

## 3. Protokol

- Model odpovídá jedním blokem `<copy turn="N" session="S">…</copy>` v ohrazení ```` (čtyři zpětné
  apostrofy). Atribut `part="i/n"` dělí dlouhou odpověď; každá část je úplný blok, akce pokračují.
- Rozšíření odpovídá blokem `<copy-results turn="N-1" session="S">` s `<result of=… status=…>` pro každou
  akci, `<diagnostics>`, `<note>` (co agent opravil nebo udělal sám), `<user>` (poznámky a odpovědi
  uživatele), `<protocol-error>` a připomínkou formátu v jazyce uživatele.
- Tabulka nástrojů (`src/protocol/schema.ts`) je jediný zdroj pravdy: generuje popis v instrukcích
  agenta i v preambuli, validaci v parseru a dispatch v runneru.
- Parser (`src/protocol/parser.ts`) hledá blok strukturně (těla akcí přeskakuje, kandidáty uvnitř
  jiných zahazuje, preferuje blok s očekávaným kolem), odstraňuje ohrazení, dekóduje escapované
  značky, CDATA a entity, dorovnává zaměněné uzavírací tagy, a useknutou akci nikdy nevykoná.

## 4. Doručení promptu (kroky)

`Controller.buildSteps` rozdělí prompt na kroky: části textu podle `prompt.maxChars` a nakonec krok
s přílohami (soubory). Každý krok je jedno `Ctrl+V`. Na Windows vlastník schránky pozná vložení textu
(WM_RENDERFORMAT) a další krok se zkopíruje sám; jinde a při selhání je tlačítko *Další krok*
(`Ctrl+Alt+N`). `prompt.asFile` dá text promptu jako `copy-prompt-N.txt` mezi soubory (jediné Ctrl+V;
agent v Copilotu má v instrukcích, že prompt může přijít jako příloha).

Odpověď se převezme ze schránky, jakmile obsahuje `<copy turn=…>` a `</copy>`; po vložení promptu
i useknutý blok nebo dokument napsaný do chatu. Po návratu fokusu do VS Code se schránka přečte hned.

## 5. Kontext

1. `attachInitialBundle`: celá codebase (textové soubory podle `.gitignore`, bez binárních) jako
   jeden kompaktní `.txt` do `.copy-agent/out/` bez limitu velikosti (`context.fullBundle`, zaškrtávátko v panelu).
2. Jinak `collectAutoContext`: cesty ze zadání, názvy souborů shodné s identifikátory, obsahové shody
   identifikátorů (CamelCase, snake_case, delší slova), aktivní soubor; malé soubory celé, velké jako
   osnova + okna kolem shod; rozpočet `context.autoMaxChars`.
3. Vždy: strom projektu (kompaktní, adresáře s počty), `AGENTS.md`, pravidla, plán, diagnostika,
   `#odkazy`, aktivní soubor a výběr.

## 6. Bezpečnost a vratnost

Stejně jako whisper: allowlist/denylist a schvalování příkazů v panelu, chráněné cesty, git checkpoint
před každým kolem a Undo, změny ke schválení po hunkách, výstupy příkazů čištěné od tajemství,
kontrola zapsaných souborů (zbytky protokolu, syntaxe).

Agent nevytváří pomocné soubory mimo `.copy-agent/` ve workspace (ani v systémovém Temp: dočasný text
pro detekci vložení žije v `.copy-agent/tmp`). Při startu úkolu `safety/VcsIgnore.ts` doplní `.copy-agent/`
a `AGENTS.md` do `.gitignore` a do `svn:ignore` každé složky pod správou verzí.

## 7. Architektura

```
src/
├── extension.ts            aktivace, příkazy, stavový řádek
├── protocol/               čistá vrstva (testovaná): schema, parser, prompt, edit, section, diff, refs, slash, detect, roots, text
├── tools/                  nástroje nad Hostem: fs, grep, run, bundle, check, context (auto-kontext), refs, runner (souběžné čtení), scripttools (<call>), runtime
├── engine/                 TurnEngine (smyčka kola bez UI), Controller (VS Code orchestrace), Session, SessionData, Transcript
├── host/                   Host rozhraní, NodeHost (CLI/testy), VsCodeHost, spawn, screenshot
├── clipboard/              ClipboardBridge, ClipboardOwner (detekce vložení), FileReplyWatcher
├── review/                 ReviewManager (baseline, hunky, CodeLens, dekorace, sada pro Review změn), changeset (čistá logika sady a popisů)
├── safety/                 Policy, Approvals, Checkpoint
├── index/                  WorkspaceIndex (tabulka souborů, otisky, symboly, mezipaměť), tokens, symbols, builtin (vestavěné nástroje), IndexService (VS Code)
├── skills/                 Skills (+ skripty), Hooks, GlobalConfig (~/.copy-agent)
├── ui/                     SidebarView (webview)
└── cli/                    harness (headless), gen-instructions (instrukce pro Copilot agenta)
```

Žádné runtime závislosti; jen VS Code API a Node. Balení přes esbuild, testy vitest (`test/`).

## Rychlost: index workspace

Cíl: akce na straně VS Code nemají být tím, na co se čeká. Měření na 20 002 souborech (155 MB textu,
Linux, teplá disková cache; `0.3.1` → s indexem):

| Akce | dřív | s indexem |
|---|---|---|
| výpis všech souborů, `glob`, `ls` | 400–490 ms | 5–11 ms |
| `grep` vzácného identifikátoru | 850–1000 ms, jen prvních 5 000 souborů | 14–22 ms, všech 20 002 |
| `grep` výrazem bez pevného textu | 716 ms za 5 000 souborů | 1 735 ms za 20 002 souborů |
| blok: 6× grep, 2× read, glob, ls | 4 331 ms | 361 ms |
| kontext nového úkolu (strom, výběr souborů) | 613 ms | 120 ms |
| kontrola 6 zapsaných pythonových souborů | 6 spuštění Pythonu | 1 spuštění |

První sestavení indexu trvalo 5 s (na pozadí), další start s uloženým indexem 0,44 s bez čtení souborů.
Paměť: otisky 14 MB, mezipaměť obsahu do stropu (výchozí 96 MB), soubor indexu 31 MB. Na Windows
měřeno není; tam si to změří příkaz `/bench` přímo na workspace uživatele.

- **`src/index/WorkspaceIndex.ts`** (čistý Node): tabulka souborů (velikost, čas změny), u textových
  souborů otisk a symboly, mezipaměť bajtů souborů (LRU se stropem; při čtení všeho se neuvolňuje to,
  co bylo použito v tomtéž průchodu). Soubory nad 2 MB a binární se nečtou; text nad 512 tisíc znaků se
  neprohledává (stejná hranice jako dřív).
- **Otisk** (`tokens.ts`): Bloomův filtr trojic sousedních znaků v řádcích, po sjednocení velikosti
  ASCII písmen a nahrazení znaků mimo ASCII jedním zástupným. Z regulárního výrazu se vezmou doslovné
  kusy, které ve shodě být musí (větve `a|b` zvlášť; skupiny, třídy, nepovinné znaky kus ukončí). Soubor
  bez některé trojice kusu shodu mít nemůže. Výraz bez použitelného kusu = prohledat vše. Otisk smí říct
  „možná“ zbytečně, nikdy „ne“ chybně; hlídá to test, který porovnává výstup s hledáním hrubou silou.
- **Symboly** (`symbols.ts`): definice po řádcích regulárními výrazy podle přípony (PL/SQL: balíky,
  procedury, funkce, typy, tabulky…; TS/JS/Java/C#/Go/Rust: třídy, metody, funkce; Python; nadpisy
  Markdownu). Slouží nástrojům `symbols`, `code`, `usages`, `outline`.
- **Aktuálnost**: `touch(cesta)` od sledování souborů a od vlastních zápisů hostitele; po `<run>` ve
  VS Code `settle()` (další dotaz počká 300 ms na události) a průchod disku na pozadí; `markStale()`
  (další dotaz si disk projde sám) u hostitele bez sledování souborů. Neuložené texty z editoru mají
  přednost před diskem a prohledají se vždy. `<read>`, `<write>` a `<edit>` čtou soubor vždy z disku.
- **Uložení**: `index.bin` v úložišti rozšíření pro workspace (tabulka, otisky, symboly; obsah ne). Po
  startu se načte a srovná s diskem podle velikosti a času změny.
- **`IndexService`** (VS Code): jedna instance pro složky workspace, sledování souborů, nastavení
  `copyAgent.index.*`, příkazy přestavění a měření.
- **Další zrychlení v téže změně**: kontrola zapsaných souborů až na konci bloku, každý soubor jednou
  v konečném stavu, souběžně a Python jedním procesem; čekání na diagnostiku editoru podle událostí
  (konec 300 ms po poslední změně, 800 ms když se žádný jazykový server neozve, dřív pevných 1 200 ms);
  git checkpoint jen u bloku, který může něco změnit; změny ke schválení se pro panel nečtou z disku při
  každém překreslení; `-NoProfile` pro PowerShell; rychlejší rozpoznání kódování (nativní kontrola UTF-8).
- **Co zůstává pomalé**: hledání výrazem bez pevného textu čte všechno (rychleji než dřív na soubor, ale
  všech souborů); příkazy v `<run>` trvají, kolik trvají (každé spuštění PowerShellu je nový proces).

## Nástroje (`<call>`)

Mezi skillem (text s postupem, skript si model pouští přes `<run>` a čte jeho výstup) a MCP (Copilot
v Teams ho připojit neumí). Nástroj je funkce se specifikací; Copy Agent je pro model v Teams jeho
„MCP klient“: model napíše `<call>`, Copy Agent nástroj spustí a vrátí odpověď.

- **Složka** `~/.copy-agent/tools/<název>/` (globální) nebo `.copy-agent/tools/<název>/` (projekt, má
  přednost): `tool.json` + skript. `tool.json`: `name` (= složka), `description`, `inputSchema` (JSON
  Schema jako u nástrojů MCP: `type`, `description`, `enum`, `default`, `pattern`, `minimum`, `maximum`,
  `items`, `required`), `output`, `run` (příkaz ve složce nástroje; `python …` se přepíše na příkaz,
  kterým tu Python opravdu jde spustit), `readOnly`, `timeout` (s, výchozí 30), `maxChars` (výchozí
  20 000), `examples`. Neplatný `tool.json` se modelu nenabízí; panel ukáže chyby.
- **Smlouva skriptu**: na stdin jeden JSON `{"args", "tool", "workspace", "roots"}`, prostředí navíc
  `COPY_AGENT_WORKSPACE`, `COPY_AGENT_TOOL_DIR`, `COPY_AGENT_ROOTS`; odpověď na stdout (JSON se zhustí na
  řádek, jinak text); chyba = nenulový návratový kód a text na stderr. Každé volání je nový proces.
- **Volání**: `<call tool="x" a="1"/>` (atributy se převedou podle schématu na čísla, true/false,
  seznamy) nebo `<call tool="x">{JSON}</call>`. Argumenty se ověří před spuštěním; chyba se vrátí
  s podpisem. Výsledek `<result of="call" tool="x" …krátké argumenty… status ms>`. Čtecí nástroje běží
  souběžně s ostatními čtecími akcemi. Odpověď nad `maxChars` jde do `.copy-agent/out/call-…`, model
  dostane začátek (celé řádky) a cestu pro `<read lines>`.
- **Důvěra** (`ToolGate`): otisk obsahu složky (bez `data/`, `__pycache__`, `.pyc`) uložený v globalState
  rozšíření. Nový nebo změněný nástroj se spustí až po schválení, i globální: model smí zapisovat do
  `~/.copy-agent`, takže by jinak mohl přepsat důvěryhodný nástroj a spustit libovolný kód bez dotazu.
  Nástroj bez `readOnly: true` se schvaluje při každém volání. Režim auto povoluje i nástroje.
- **Po zápisu**: když blok změnil složku nástroje a nástroj nevolal, Copy Agent ho po bloku vyzkouší na
  příkladech (nejvýš 3, jen čtecí nástroj); chybný `tool.json` vrátí jako chybu, takže `<done>` neprojde.
- **Vznik**: skill `/tool-creator`, návrh `<suggest kind="tool">` (tělo = tool.json, pak `--- run.py ---`
  a skript), nebo ručně.
- Logika je v `src/tools/scripttools.ts` bez `vscode` (testy `test/scripttools.test.ts`); schvalovací
  karta, `/tools` a list v panelu jsou v `Controller` a `SidebarView`.

## 8. Známá omezení

- Velké přílohy čte Copilot po částech; model to ví a chybějící soubory si vyžádá. Příloha nemá limit
  velikosti; u obřího projektu ji vypněte zaškrtávátkem a nechte jen automatický výběr souborů.
- Soubory do schránky a detekce vložení jsou jen na Windows; jinde se příloha přikládá ručně
  z `.copy-agent/out/` a další krok se spouští tlačítkem.
- Screenshoty jen na Windows.

## Změny agenta v rozšíření Review změn

Výchozí nástroj na procházení změn je rozšíření Review změn (`dapar.vscode-review`); vestavěné
procházení v editoru zůstává jako záloha. Rozšíření se neváží na sebe kódem, jen souborem a příkazy:

- **Sada změn.** `ReviewManager` po každé změně zapíše čekající změny do `.copy-agent/review/`:
  `sada.json` (soubory absolutní cestou, jejich stav, příkazy pro přijetí a zamítnutí) a `base/`
  se zněním souborů před změnou. Review změn nad sadou počítá diff samo, bez správy verzí, a svoje
  schválení ukládá do téže složky (`uzivatel.json`). Vyřízená sada schválení i popisy maže.
- **Příkazy.** `reviewZmen.sada(soubor, cesta?)` otevře review nad sadou, `reviewZmen.stavSady(soubor)`
  vrátí kroky plánu a soubory s počty schválených kusů pro přehled v panelu. Opačným směrem volá
  Review změn `copyAgent.review.acceptAll` a `copyAgent.review.revert({ soubor, cely, upravy })`:
  zamítnutý kus vrací Copy Agent, protože zná kódování souboru a hlásí zamítnutí modelu.
- **Popisy od modelu.** S volbou `review.describeChanges` dostane úkol pokyn psát za každou změnu
  `<change>`. `ToolRunner` popis přiřadí k poslední změně souboru v bloku (znění před akcí a po ní),
  `changeset.ts` z popisů spočítá rozsahy řádků v aktuálním znění (pozdější akce je posouvají nebo
  přepisují) a zapíše `agent.json` vedle sady: kusy, rizika a kroky plánu podle `step`. Pokyn je
  jen v úkolu; instrukce agenta v Copilotu znají akci, ale ne povinnost ji psát.
