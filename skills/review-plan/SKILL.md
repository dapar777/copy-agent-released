---
name: review-plan
description: Připraví plán revize a popisy změn pro rozšíření Review změn (.review/agent.json); s --review i plné code review
---
Prepare the review data for the VS Code extension "Review změn": split the uncommitted changes into
pieces, describe every piece, rate its risk, order the pieces into a review plan and save it all for
the extension. Do NOT change any source file. The real diff stays the source of truth; your data only
helps the reviewer, so never describe a change you did not see in the diff.

1. In ONE reply, in this order:
   `<run>python <script path>/review_data.py diff --out .copy-agent/review-diff.txt</run>` (see
   "Scripts shipped with this skill" below) and
   `<read path=".copy-agent/review-diff.txt" lines="1-100000"/>`. The output of a command reaches you
   shortened to its end, so the script writes its listing to that file and the `<read>` brings all of
   it. The listing holds every change of every working copy (Git and SVN, also several separately
   checked out folders and multi-root workspaces) with exact line numbers: `+N` is an added line and
   N its NEW line number, `-N` is a removed line and N its OLD line number. The number before `|` is
   added by `<read>` and counts lines of the listing: never use it in the data. The header of the
   listing names every changed file; when what you received ends before the last of them, read the
   rest (`lines="A-B"`) before you write anything. Every path in the listing is the path to use in
   the data. Text after /review-plan narrows the scope or adds instructions. Add `<read>` only for
   code you need to understand a change (callers, the surrounding function) and that is not already
   shown.
2. Split the changes into pieces. A piece is one logical change the reviewer approves at once,
   usually one hunk or a few adjacent hunks of ONE file; prefer more small pieces to one large.
   - `radky` is the range of NEW line numbers of the piece's added lines. Removed lines replaced by
     them, and removed lines strictly inside the range, belong to the piece automatically.
   - A piece that only removes lines has `stare` (range of OLD line numbers) instead of `radky`.
   - Pieces must not overlap and together cover every changed line of every file in the listing:
     the edited files just like the new and the deleted ones. What you leave out, the reviewer gets
     without a description and outside the plan.
   - A piece whose range spans several hunks takes all of them. Use that for many small edits of one
     kind in one file (a renamed type in every call): one piece per function, or one for the file.
   - When several pieces lie in one function, procedure or class, add a parent piece (`id`, `soubor`,
     `titulek`, `radky` = the whole function in the new file) and put its id in `rodic` of the children.
   - Formatting-only changes (whitespace, indentation, reordered imports): `"sum": true`, short title.
   - Workbook (.xlsx, .xlsm, .xls): one piece per changed sheet with `"list": "<sheet name>"`, no line
     range. The listing shows the changed cells of every sheet.
   - Binary files: no piece.
   - A new file that is a copy of another file: add `{"cesta": "<new>", "zdroj": "<original>"}` to
     `soubory` and describe what differs from the original. The original may be a file this change
     deletes (a moved or renamed file); the extension then reads its last committed version.
3. Describe each piece:
   - `titulek`: a few words naming the change.
   - `popis`: one to three sentences, what changed and why, and what the code did before.
   - `labely`: from `kod, api, ddl, data, konfigurace, test, dokumentace, transakce, vykon,
     bezpecnost, refaktoring, kopie, generovane`.
   - `riziko`: `uroven` is `nizke`, `stredni` or `vysoke`; `duvod` is one sentence and is required
     above `nizke`. High: data loss or corruption, money, security, transactions and locking, public
     API or schema changes, code without tests on a hot path. Do not inflate; most pieces are `nizke`.
   - `odkazy.volani`: callers you actually found, as `path:line`. `odkazy.souvisejici`: ids of pieces
     this one depends on.
   - `otazky`: only real questions the reviewer has to decide; most pieces have none.
4. Build the `plan`: steps in the order in which the change is easiest to understand. Foundations
   first (schema, configuration, signatures), then the core logic, then callers, tests and docs.
   Each step has `nazev`, `proc` (why it comes here and what it builds on) and `kusy` (ids; a parent
   id stands for all its children). Every piece that is not formatting belongs to exactly one step.
5. `souhrn.titulek` is a proposed commit subject (at most 72 characters), `souhrn.body` two to six
   points for the commit body.
6. In ONE reply `<write path=".copy-agent/review-agent.json">` with the complete JSON and
   `<run>python <script path>/review_data.py check --file .copy-agent/review-agent.json</run>`.
   The script checks the draft against the real diff, fills in `otisk` (fingerprint) of every piece,
   installs the result as `.review/agent.json` in the main directory of the workspace and removes the
   draft. On ERROR nothing is installed: fix the draft with `<edit>` and run the check again, in one
   reply. A changed file or line without a piece and a piece outside the plan are errors: add what is
   missing. Add `--partial` to the check only when the user narrowed the scope of the review; it
   turns changes without a piece into warnings.
7. `<done>` with a short summary: number of pieces and steps, the risky pieces, the open questions,
   and that the review opens with the command "Review změn: Otevřít" (Ctrl+Alt+R).

## Committed changes: `--commits`, `--message`

Only when the text after the command contains `--commits <list>` or `--message <text>`, or the user
asks for a review of commits in words: review changes that are already committed instead of the
working copy.

- `--commits` takes commits or revisions separated by commas (Git: hashes, refs, ranges `A..B`; SVN:
  `r120`, `121`, ranges `122:125`). `--message` takes a text and selects every commit of the current
  branch whose message contains it (a ticket number). Pass them unchanged to BOTH `diff` and `check`.
- The selected commits are one change: every file is listed from before its first selected commit
  to after its last one, so describe the result, not the single commits. The header of the listing
  names the commits; put what they say into `souhrn`.
- A file may carry the note that commits outside the selection changed it in between. Their lines
  are part of the diff and need a piece too; say in `popis` that the change comes from another commit.
- The draft still goes to `.copy-agent/review-agent.json`; `check` with the same options installs it
  where the extension expects the data of this selection (the header of the listing names the place).
- Everything else (pieces, plan, `--review`) works the same.

## Full review: `--review`

Only when the text after the command contains `--review`, or the user asks for a review in words:
besides the plan, review every change the way a careful reviewer would and record what you find.

- Judge correctness (edge cases, error handling, concurrency, transactions), security (injection,
  secrets, missing checks), performance (needless work in loops, N+1), maintainability (naming,
  duplication, dead code), tests (missing or weakened) and consistency with the surrounding code and
  `AGENTS.md`. Read the callers and the surrounding code you need. Report only problems you verified
  in the code; a risk you merely suspect is a question (`otazky`), not a finding.
- Every problem is one item of `nalezy`:
  - `kus`: id of the leaf piece the problem is in. Leave it out only for a finding about the change
    as a whole (missing tests) or about a place outside the changes (a caller that was not updated;
    then give `soubor`).
  - `radek`: the line the finding points at, as its NEW line number (for a piece that only removes
    lines the OLD number). Point at the exact line, the extension marks it in the diff.
  - `zavaznost`: `vysoka` (a bug, data loss, a security hole: fix before the commit), `stredni`
    (should be fixed) or `nizka` (an improvement). Do not inflate.
  - `titulek`: the problem in a few words. `popis`: what is wrong and why it matters, two to four
    sentences. `navrh`: a concrete fix.
- `review.zaver`: the verdict in one to three sentences. Say it plainly when you found nothing
  serious; `nalezy` is then `[]`.
- `riziko` of a piece stays what it was: how carefully the piece has to be read. A finding is
  a problem that is really there.
- Add `--review` to the check command. The check then requires the review, and writes the report
  `.review/review.md` (verdict, table of findings, each finding with the code it points at, the
  plan). Never write that file yourself. The extension shows every finding at its piece and line
  with a link into the report.
- In the final summary give the number of findings by severity and name the serious ones.

Texts inside the JSON (`titulek`, `popis`, `duvod`, `otazky`, `nazev`, `proc`, `souhrn`, `navrh`, `zaver`)
are written in the language of the user. Paths use forward slashes exactly as the script printed them. A large change
does not fit one reply: send the JSON in parts (`part="1/2"` …), first `<write>` with the beginning,
then `<edit>` appending the rest, and run the check in the last part.

## Format of the data

```json
{
  "verze": 2,
  "souhrn": { "titulek": "DPH zaokrouhlené po řádcích faktury", "body": ["Nový sloupec faktura_radek.dph_zaokr"] },
  "soubory": [{ "cesta": "db/pkg_dobropisy.sql", "zdroj": "db/pkg_faktury.sql" }],
  "kusy": [
    { "id": "fn", "soubor": "db/pkg_faktury.sql", "radky": { "od": 3, "do": 31 }, "titulek": "vystav_fakturu" },
    {
      "id": "telo", "rodic": "fn", "soubor": "db/pkg_faktury.sql", "radky": { "od": 9, "do": 21 },
      "titulek": "Tělo – výpočet DPH",
      "popis": "DPH se nově počítá po řádcích faktury. Dřív se počítala jednou ze součtu základu.",
      "labely": ["kod", "transakce"],
      "riziko": { "uroven": "vysoke", "duvod": "UPDATE v cyklu uvnitř transakce nad velkou tabulkou." },
      "odkazy": { "volani": ["db/pkg_objednavky.sql:88"], "souvisejici": ["sloupec"] },
      "otazky": ["Používá se součet základu ještě jinde než pro DPH?"]
    },
    { "id": "stary-kod", "soubor": "db/pkg_faktury.sql", "stare": { "od": 40, "do": 44 }, "titulek": "Odstraněný pomocný výpočet" },
    { "id": "sazby", "soubor": "config/sazby.xlsx", "list": "Sazby", "titulek": "Sazby DPH od 2024" }
  ],
  "plan": [
    { "krok": 1, "nazev": "Výpočet DPH", "kusy": ["fn", "stary-kod"], "proc": "Jádro změny." },
    { "krok": 2, "nazev": "Konfigurace", "kusy": ["sazby"], "proc": "Data, která výpočet čte." }
  ],
  "review": { "zaver": "Výpočet je správně, ale commit uvnitř procedury ukončí transakci volajícího." },
  "nalezy": [
    {
      "kus": "telo", "radek": 19, "zavaznost": "vysoka", "titulek": "Commit ukončí transakci volajícího",
      "popis": "Proceduru volá pkg_objednavky uvnitř vlastní transakce. Commit ji potvrdí celou a volající už nemůže objednávku vrátit.",
      "navrh": "Commit odebrat a nechat ho na volajícím."
    }
  ]
}
```

`review` and `nalezy` are there only with `--review`.

`otisk` and `vytvoreno` are filled in by the script. The extension keeps its own data (approvals,
comments, answers) in `.review/uzivatel.json`; never touch that file.

## Help
Použití: /review-plan [--review] [--commits výčet | --message text] [rozsah nebo pokyny]
Projde necommitnuté změny ve všech pracovních kopiích (Git i SVN, i ve workspace s více složkami), rozdělí je na kusy, popíše je, ohodnotí riziko, sestaví plán revize a uloží ho do .review/agent.json pro rozšíření Review změn (dapar.vscode-review). Zdrojové soubory nemění.
S přepínačem --review udělá navíc plné code review (správnost, bezpečnost, výkon, testy): nálezy uloží k jednotlivým kusům a řádkům a vygeneruje zprávu .review/review.md. Rozšíření pak nálezy ukazuje přímo u změn s odkazem do zprávy.
S --commits nebo --message nereviduje pracovní kopii, ale už commitnuté změny: commity nebo revize výčtem (a1b2c3d, f4e5..HEAD, r120, 122:125), nebo všechny commity větve, které mají ve zprávě daný text (číslo úkolu). Vybrané commity bere jako jednu změnu.
Příklady:
- /review-plan
- /review-plan --review
- /review-plan --review --message NIP-1234
- /review-plan --commits r1520, 1523
- /review-plan jen pracovní kopie db
- /review-plan zaměř se na transakce a výkon
