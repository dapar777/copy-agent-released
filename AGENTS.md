# Instrukce pro agenty v tomto projektu

- Jazyk: TypeScript, VS Code extension. Bundluje se přes `npm run build` (esbuild) do `dist/`
  (extension.js, harness.js, gen-instructions.js).
- Typová kontrola: `npx tsc --noEmit`. Unit testy: `npx vitest run` (jen čistá vrstva bez `vscode`:
  `src/protocol`, `src/tools`, `src/engine/TurnEngine.ts`, `src/host/NodeHost.ts`).
- Kód, který sahá na `vscode` API, nelze testovat Vitestem; logiku drž v `src/protocol`, `src/tools`
  a `src/engine/TurnEngine.ts` bez importu `vscode`.
- Komentáře a UI texty česky, texty pro model (prompt.ts, skills/) anglicky.
- Výstup úspěšného `<run>` jde modelu jen jako posledních N znaků (`compactOkOutput`; výchozí 15 000,
  nastavení `copyAgent.prompt.runOutputMaxChars`, uživatel ho může i snížit). Skript
  skillu, jehož výstup jsou data pro model, je proto zapisuje do souboru v `.copy-agent/` a skill si
  ho čte přes `<read … lines="A-B">` ve stejné odpovědi (viz `skills/review-plan`).
- Změny agenta se procházejí v rozšíření Review změn. Spojuje je soubor sady v `.copy-agent/review/`
  a příkazy (`reviewZmen.sada`, `reviewZmen.stavSady`, `copyAgent.review.revert`), viz DESIGN.md;
  mění se spolu s `dapar777/vscode-review`. Logika sady a popisů `<change>` je v `src/review/changeset.ts`
  bez `vscode` a má testy; `ReviewManager` a panel se Vitestem netestují.
- `skills/review-plan` (skript i pravidla) je kopie ze `dapar777/vscode-review` (`skill/review-plan`);
  mění se tam i tady, SKILL.md se liší jen kroky pro protokol Copy Agenta.
- Index workspace je v `src/index/` (`WorkspaceIndex`, `tokens`, `symbols`, `builtin` bez `vscode`;
  `IndexService` je lepidlo pro VS Code), testy `test/index.test.ts`. Kdo mění předvýběr při hledání
  (`requiredFragments`, otisk), musí nechat projít test „gives exactly what a brute-force search gives“:
  hledání přes index smí být jen rychlejší, nikdy ne jiné. Nástroje čtou hromadně přes `host.index`
  (když je), jednotlivé `<read>`/`<write>`/`<edit>` vždy přímo z disku. Popis v DESIGN.md.
- Nástroje pro `<call>` (načtení `tool.json`, kontrola argumentů, spuštění, otisk a důvěra) jsou v
  `src/tools/scripttools.ts` bez `vscode`, testy v `test/scripttools.test.ts` (potřebují Python 3, jinak
  se testy se skriptem přeskočí). Popis je v DESIGN.md, oddíl Nástroje.
- Neměň `package.json` `contributes` bez doplnění odpovídajícího `registerCommand` v `src/extension.ts`.
- Instrukce pro agenta v Copilotu se generují: po změně `src/protocol/prompt.ts` nebo `schema.ts`
  spusť `npm run build && node dist/gen-instructions.js --write` (limit 8 000 znaků, hlídá test).
