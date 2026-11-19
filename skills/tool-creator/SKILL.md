---
name: tool-creator
description: Vytvoří nebo upraví nástroj, který model volá akcí <call> (tool.json + skript v Pythonu); globálně v ~/.copy-agent/tools, s --local v projektu
---
Create (or update) a Copy Agent TOOL from the request after /tool-creator. A tool is a function with a
specification: the model sees only its signature and description, calls it with
`<call tool="name" arg="…"/>` and gets back only its response (JSON or text), never its code. Use it for
data the model needs again and again (a table structure, commit history, values from a config, cells of
a sheet), so the model stops writing commands and digging through their output.

Tools live in exactly two places:
- GLOBAL (default): `~/.copy-agent/tools/<name>/` (every project). Write the path literally with `~`.
- LOCAL (`--local` in the request): `.copy-agent/tools/<name>/` (this workspace only; in a multi-root
  workspace in the first folder).

## Procedure

1. Parse the request: tool name (lowercase, words joined by `-`, e.g. `db-object`), what it returns,
   its arguments, `--local`/`--global`. To update an existing tool, `<read>` its `tool.json` and script
   first and keep what works. Ask with `<ask>` only when the purpose is genuinely unclear.
2. Write `<folder>/tool.json`:

   ```
   {
     "name": "db-object",
     "description": "Structure of an Oracle table, view or package: columns, indexes, procedures",
     "inputSchema": {
       "type": "object",
       "properties": {
         "name": { "type": "string", "description": "object name, e.g. INVOICE_LINE" },
         "schema": { "type": "string", "default": "NIP" }
       },
       "required": ["name"]
     },
     "output": "JSON: type, columns [{name, type, nullable}], indexes, procedures [{name, params}]",
     "run": "python run.py",
     "readOnly": true,
     "timeout": 30,
     "examples": [{ "args": { "name": "DUAL" } }]
   }
   ```

   - `name` = the folder name. `description`: one line, what it does and returns.
   - `inputSchema`: JSON Schema of the arguments (as for MCP tools). Each property has `type` (string,
     number, integer, boolean, array, object) or `enum`, and a short `description`; optional `default`,
     `pattern`, `minimum`, `maximum`, `items`. List mandatory ones in `required`.
   - `output`: what the response contains, so the model knows what it gets.
   - `run`: the command started inside the tool folder. Use the script language the "Environment"
     section names under SCRIPTS (Python with the standard library only unless it says otherwise);
     never PowerShell or batch unless the user asks for it.
   - `readOnly`: true when the tool only reads (no file writes, no database changes, nothing sent
     anywhere). Such a tool runs without asking once the user trusts it; any other tool is confirmed by
     the user before every call.
   - `timeout` in seconds (default 30), optional `maxChars` for the response (default 20000; a longer
     response is saved to a file and the model gets its start).
   - `examples`: 1–3 argument sets that work on any machine and change nothing. They are mandatory for a
     read-only tool: the tool is tried on them as soon as it is saved.
3. Write the script (`run.py`), complete and runnable, with a usage comment at the top:
   - Read ONE JSON object from stdin: `{"args": {...}, "tool": "...", "workspace": "<first workspace
     folder>", "roots": [...]}`. Resolve relative paths from the arguments against `workspace`.
   - Print ONE JSON value to stdout (an object or a list) with only what the model needs, compact; or
     plain text when that is clearer. Nothing else on stdout (no progress messages).
   - On failure print a short, specific message to stderr and exit with a non-zero code.
   - Read and write files as UTF-8. Run external commands (svn, git, sqlplus…) with
     `subprocess.run([...], capture_output=True, text=True, encoding="utf-8", errors="replace",
     timeout=…)`, never through a shell string built from arguments.
   - Credentials and connection settings are NOT arguments and you never write them into the tool:
     read them from a config file in the tool folder (e.g. `config.json`, which the user fills in) or
     from an environment variable, say which in the Help, and fail with a clear message when they are
     missing. Never print a secret.
   - Keep caches or state only in the subfolder `data/` of the tool (it is not part of the content the
     user approves, so writing there does not make the tool "changed").
4. Do not call the tool yourself in this reply. After the block, Copy Agent validates `tool.json` and
   runs each example; the results come back as `<result of="call" tool="<name>" example="N">` (or
   `check="after change"` when `tool.json` is invalid). The user approves the first run. Fix what is
   wrong with `<edit>` in the next reply.
5. When the examples pass, finish with `<done>`: where the tool is, its signature, what the user must
   fill in (config file, environment variable), and that the model sees it under "Tools" from the next
   task on; it can be tried in the Copy Agent panel (wrench icon) and listed with /tools.

Switches the user may add: `--local` (project tool), `--global` (explicit default), `--update` (change an
existing tool of that name).

## Help
Použití: /tool-creator <název> <co má nástroj vracet> [--local]
Vytvoří nástroj, který model volá akcí `<call>` a dostane jen jeho odpověď (JSON), bez čtení skriptu:
složku `<název>/` s `tool.json` (popis, argumenty jako JSON Schema, příkaz) a skriptem v Pythonu. Hned
po uložení se nástroj vyzkouší na příkladech; první spuštění schválíte vy. Výchozí umístění je globální
(`~/.copy-agent/tools`), `--local` ho uloží do `.copy-agent/tools` jen pro tento projekt.
Přepínače:
- --local: nástroj jen pro tento projekt (jinak globální)
- --global: výslovně globální (výchozí)
- --update: upraví existující nástroj stejného jména
Příklady:
- /tool-creator db-object struktura tabulky nebo balíku v Oracle podle názvu, připojení z config.json
- /tool-creator svn-log --local commity aktuální větve podle textu ve zprávě nebo podle revizí
- /tool-creator xls-cells hodnoty buněk z listu sešitu Excelu v zadaném rozsahu
