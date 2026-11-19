#!/usr/bin/env python3
"""Helper for the review-plan skill: data for the VS Code extension "Review změn".

Usage:
  python review_data.py diff  [options]   print every change with exact line numbers
  python review_data.py check [options]   validate .review/agent.json and fill in fingerprints

Options:
  --folder DIR       workspace folder to scan, repeatable (pass every root of a multi-root workspace);
                     default: the folders in the environment variable COPY_AGENT_ROOTS, else the current dir
  --main DIR         main directory (holds .review/, paths are relative to it); default: the only
                     folder, or for several folders the directory of COPY_AGENT_WORKSPACE_FILE when
                     they all lie under it, otherwise their common parent
  --depth N          how deep to look for separately checked-out working copies (default 2)
  --scope MODE       git: auto (staged if anything is staged, else working tree), staged, working
  --changelist NAME  svn: only files of this changelist
  --commits LIST     review committed changes instead of the working copy: commits or revisions separated
                     by commas or spaces. Git: hashes, refs, ranges A..B. SVN: r120, 121, ranges 122:125.
  --message TEXT     review committed changes: every commit of the current branch whose message contains
                     TEXT (case-insensitive), e.g. a ticket number. May be combined with --commits.
  --encoding NAME    encoding of files that are not valid UTF-8 (default cp1250)
  --context N        diff: context lines around changes (default 3)
  --max-lines N      diff: print at most N changed lines per file (default 400, 0 = no limit)
  --path PATH        diff: only this file or directory (as printed in the listing), repeatable
  --out FILE         diff: write the listing to FILE and print only a short summary; for tools that
                     shorten long command output, read the file instead
  --file PATH        check: file to validate (default <main>/.review/agent.json); a file from elsewhere
                     is installed to <main>/.review/agent.json when it passes, and then removed
  --partial          check: the user narrowed the scope, so changes without a piece are only warnings
  --review           check: the user asked for a full review, so "review" and "nalezy" are required
  --no-write         check: only validate, write nothing

Works with Git and SVN working copies, several of them in one workspace. Unversioned folders are
ignored. With --commits or --message the selected commits are reviewed as one change: every file is
compared from before the first selected commit that touches it to after the last one, and the data
live in <main>/.review/commity/<key>/ (the diff command prints the path). Pass the same options to
diff and check. Python 3.8+, standard library only. The mapping of pieces to changed lines and the
fingerprint are the same as in the extension (src/core/pieces.ts); keep them in sync.
"""
import argparse
import codecs
import datetime
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import unicodedata
import urllib.parse
import zipfile

RISKS = {"nizke", "stredni", "vysoke"}
SEVERITIES = ["vysoka", "stredni", "nizka"]
SEVERITY_CS = {"vysoka": "vysoká", "stredni": "střední", "nizka": "nízká"}
RISK_CS = {"nizke": "nízké", "stredni": "střední", "vysoke": "vysoké"}
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _c1(err):  # bytes undefined in cp1250 map to the same code point, as browsers do
    return "".join(chr(b) for b in err.object[err.start:err.end]), err.end


codecs.register_error("review-c1", _c1)


def decode(data, fallback):
    if not data:
        return ""
    if data[:2] == b"\xff\xfe":
        return data[2:].decode("utf-16-le", "replace")
    if data[:2] == b"\xfe\xff":
        return data[2:].decode("utf-16-be", "replace")
    body = data[3:] if data[:3] == b"\xef\xbb\xbf" else data
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return body.decode(fallback, "review-c1")
        except LookupError:
            return body.decode("latin-1")


def is_binary(data):
    if not data or data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return False
    return b"\x00" in data[:8000]


def split_lines(text):
    if text == "":
        return []
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    return [l[:-1] if l.endswith("\r") else l for l in lines]


def run(cmd, cwd):
    try:
        p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        sys.exit("error: command not found: %s" % cmd[0])
    return p.returncode, p.stdout, p.stderr.decode("utf-8", "replace")


def slash(p):
    return p.replace("\\", "/")


# ---------------------------------------------------------------- working copies
def marker(d):
    if os.path.exists(os.path.join(d, ".svn")):
        return "svn"
    if os.path.exists(os.path.join(d, ".git")):
        return "git"
    return None


def detect_up(d):
    cur = os.path.abspath(d)
    for _ in range(40):
        m = marker(cur)
        if m:
            return m
        up = os.path.dirname(cur)
        if up == cur:
            return None
        cur = up
    return None


def find_roots(folders, main, depth):
    found = []
    for folder in folders:
        own = marker(folder)
        if own:
            found.append((folder, own))
            continue
        inside, level = [], [folder]
        for _ in range(depth):
            nxt = []
            for d in level:
                try:
                    names = sorted(n for n in os.listdir(d) if os.path.isdir(os.path.join(d, n)))
                except OSError:
                    names = []
                for n in names:
                    if n.startswith(".") or n == "node_modules":
                        continue
                    sub = os.path.join(d, n)
                    v = marker(sub)
                    if v:
                        inside.append((sub, v))
                    else:
                        nxt.append(sub)
            level = nxt
        found.extend(inside if inside else [(folder, detect_up(folder))])
    roots, seen = [], set()
    for d, vcs in found:
        d = os.path.abspath(d)
        if d in seen or not vcs:
            continue
        seen.add(d)
        prefix = slash(os.path.relpath(d, main))
        if prefix == ".":
            prefix = ""
        if prefix.startswith(".."):
            prefix = os.path.basename(d)
        roots.append({"name": prefix or os.path.basename(d), "dir": d, "prefix": prefix, "vcs": vcs})
    return sorted(roots, key=lambda r: r["name"])


class Git:
    def __init__(self, d, scope):
        self.dir, self.scope, self.staged, self.untracked = d, scope, False, set()

    def git(self, *args):
        return run(["git", "-c", "core.quotepath=off", *args], self.dir)

    @staticmethod
    def _names(out):
        parts, res, i = out.decode("utf-8", "replace").split("\0"), [], 0
        while i < len(parts) - 1:
            code = parts[i]
            i += 1
            if not code:
                continue
            if code[0] in "RC":
                res.append({"path": slash(parts[i + 1]), "status": "renamed" if code[0] == "R" else "copied", "orig": slash(parts[i])})
                i += 2
            else:
                res.append({"path": slash(parts[i]), "status": {"A": "added", "D": "deleted"}.get(code[0], "modified")})
                i += 1
        return res

    def changes(self):
        lst = []
        if self.scope != "working":
            lst = self._names(self.git("diff", "--cached", "--name-status", "-z", "-M", "--relative")[1])
        self.staged = self.scope == "staged" or (self.scope == "auto" and bool(lst))
        if not self.staged:
            has_head = self.git("rev-parse", "--verify", "-q", "HEAD")[0] == 0
            args = ("diff", "HEAD", "--name-status", "-z", "-M", "--relative") if has_head else ("diff", "--cached", "--name-status", "-z", "--relative")
            lst = self._names(self.git(*args)[1])
            known = {c["path"] for c in lst}
            for p in self.git("ls-files", "--others", "--exclude-standard", "-z")[1].decode("utf-8", "replace").split("\0"):
                if p and slash(p) not in known:
                    self.untracked.add(slash(p))
                    lst.append({"path": slash(p), "status": "added"})
        return lst

    def new(self, c):
        if c["status"] == "deleted":
            return None
        if self.staged:
            code, out, _ = self.git("show", ":./" + c["path"])
            if code == 0:
                return out
        try:
            with open(os.path.join(self.dir, c["path"]), "rb") as f:
                return f.read()
        except OSError:
            return None

    def old(self, c):
        if c["status"] == "added":
            return None
        code, out, _ = self.git("show", "HEAD:./" + c.get("orig", c["path"]))
        return out if code == 0 else None

    def diff(self, c, context):
        if c["path"] in self.untracked:
            return None
        paths = [c["orig"], c["path"]] if c.get("orig") else [c["path"]]
        base = ["-U%d" % context, "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--relative", "--", *paths]
        code, out, _ = self.git("diff", "--cached", *base) if self.staged else self.git("diff", "HEAD", *base)
        return out if code == 0 else None


class Svn:
    def __init__(self, d, changelist):
        self.dir, self.changelist = d, changelist

    def svn(self, *args):
        return run(["svn", "--non-interactive", *args], self.dir)

    def changes(self):
        code, out, err = self.svn("status", "--xml")
        if code != 0:
            sys.exit("error: svn status failed in %s: %s" % (self.dir, err.strip()))
        xml = out.decode("utf-8", "replace")
        if self.changelist:
            m = re.search(r'<changelist\s+name="%s">([\s\S]*?)</changelist>' % re.escape(self.changelist), xml)
            xml = m.group(1) if m else ""
        res = []
        for m in re.finditer(r'<entry\s+path="([^"]*)"\s*>([\s\S]*?)</entry>', xml):
            st = re.search(r"<wc-status\b([^>]*)>", m.group(2))
            st = st.group(1) if st else ""
            item = re.search(r'\bitem="([^"]*)"', st)
            item = item.group(1) if item else ""
            path = slash(m.group(1).replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&"))
            if item in ("modified", "conflicted", "replaced"):
                status = "modified"
            elif item == "added":
                status = "copied" if 'copied="true"' in st else "added"
            elif item == "deleted":
                # a deleted directory is one status entry; `svn info -R` lists its files
                info = self.svn("info", "--xml", "-R", path)[1].decode("utf-8", "replace")
                found = [re.search(r'\bpath="([^"]*)"', t) for t in re.findall(r"<entry\b([^>]*)>", info) if 'kind="file"' in t]
                for f in ([slash(m.group(1)) for m in found if m] or ([] if info else [path])):
                    res.append({"path": f, "status": "deleted"})
                continue
            else:
                continue
            full = os.path.join(self.dir, path)
            if status != "deleted" and (not os.path.exists(full) or os.path.isdir(full)):
                continue
            res.append({"path": path, "status": status})
        return res

    def new(self, c):
        if c["status"] == "deleted":
            return None
        try:
            with open(os.path.join(self.dir, c["path"]), "rb") as f:
                return f.read()
        except OSError:
            return None

    def old(self, c):
        if c["status"] == "added":
            return None
        code, out, _ = self.svn("cat", "-r", "BASE", c["path"])
        return out if code == 0 else None

    def diff(self, c, context):
        # Plain `svn diff` (what the extension runs) has 3 lines of context. Another size needs
        # `-x -U<N>`, which Subversion older than 1.9 rejects; then the default is good enough.
        if context != 3:
            code, out, _ = self.svn("diff", "--internal-diff", "-x", "-U%d" % context, c["path"])
            if code == 0 and out:
                return out
        code, out, _ = self.svn("diff", "--internal-diff", c["path"])
        return out if code == 0 and out else None


# ---------------------------------------------------------------- committed changes
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


def parse_list(text):
    return [x for x in re.split(r"[\s,;]+", text or "") if x]


def selection_key(items, message):
    """Names the data folder of a selection of commits; the extension computes the same key."""
    return hashlib.sha256(("s=%s\nz=%s" % (",".join(items), message.strip())).encode("utf-8")).hexdigest()[:10]


class GitCommits:
    """The selected commits of a Git working copy as one change: a file goes from the parent of the first
    selected commit that touches it to the last one. The same as gitCommitProvider() in the extension."""

    def __init__(self, d, items, message):
        self.dir, self.items, self.message = d, items, message.strip()
        self.commits, self.missing, self.touched, self.cache = [], [], {}, {}

    def git(self, *args):
        return run(["git", "-c", "core.quotepath=off", *args], self.dir)

    def show(self, rev, path):
        key = (rev, path)
        if key not in self.cache:
            code, out, _ = (1, b"", "") if rev == EMPTY_TREE else self.git("show", "%s:./%s" % (rev, path))
            self.cache[key] = out if code == 0 else None
        return self.cache[key]

    def changes(self):
        hashes = []
        for item in self.items:
            code, out, _ = self.git("rev-list", item) if ".." in item else self.git("rev-parse", "--verify", "-q", item + "^{commit}")
            found = out.decode("utf-8", "replace").split()
            if code == 0 and found:
                hashes += [h for h in found if h not in hashes]
            else:
                self.missing.append(item)
        if self.message:
            code, out, _ = self.git("log", "-i", "-F", "--grep=" + self.message, "--format=%H")
            hashes += [h for h in out.decode("utf-8", "replace").split() if code == 0 and h not in hashes]
        if not hashes:
            return []
        order = self.git("rev-list", "--topo-order", "--reverse", *hashes)[1].decode("utf-8", "replace").split()
        ordered = [h for h in order if h in set(hashes)]
        meta = self.git("log", "--no-walk=unsorted", "--format=%H%x1f%h%x1f%an%x1f%cI%x1f%s", *ordered)[1].decode("utf-8", "replace")
        by_id = {l.split("\x1f")[0]: l.split("\x1f") for l in meta.split("\n") if l.strip()}
        self.commits = [{"id": h, "short": by_id[h][1], "author": by_id[h][2], "date": by_id[h][3], "subject": by_id[h][4]} for h in ordered if h in by_id]
        for c in self.commits:
            base = c["id"] + "^" if self.git("rev-parse", "--verify", "-q", c["id"] + "^")[0] == 0 else EMPTY_TREE
            parts = self.git("diff", "--name-status", "-z", "--no-renames", "--relative", base, c["id"])[1].decode("utf-8", "replace").split("\0")
            for i in range(0, len(parts) - 1, 2):
                t = self.touched.setdefault(slash(parts[i + 1]), {"base": base, "ids": []})
                t["last"] = c["id"]
                t["ids"].append(c["short"])
        selected, res = {c["short"] for c in self.commits}, []
        for path, t in self.touched.items():
            old, new = self.show(t["base"], path), self.show(t["last"], path)
            if (old is None and new is None) or old == new:  # added and removed again, or a change taken back
                continue
            between = self.git("log", "--format=%h", t["last"] if t["base"] == EMPTY_TREE else "%s..%s" % (t["base"], t["last"]), "--", path)[1].decode("utf-8", "replace").split()
            res.append({"path": path, "status": "added" if old is None else "deleted" if new is None else "modified",
                        "commits": t["ids"], "foreign": [h for h in between if h not in selected][::-1]})
        return res

    def old(self, c):
        return self.show(self.touched[c["path"]]["base"], c["path"])

    def new(self, c):
        return self.show(self.touched[c["path"]]["last"], c["path"])

    def diff(self, c, context):
        t = self.touched[c["path"]]
        code, out, _ = self.git("diff", "-U%d" % context, "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", t["base"], t["last"], "--", c["path"])
        return out if code == 0 else None


def svn_log(xml):
    unx = lambda v: v.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&")
    out = []
    for m in re.finditer(r'<logentry\s+revision="(\d+)"\s*>([\s\S]*?)</logentry>', xml):
        body = m.group(2)
        first = lambda rx: (re.search(rx, body) or [None, ""])[1]
        paths = [{"action": (re.search(r'\baction="([^"]*)"', a) or [None, ""])[1], "kind": (re.search(r'\bkind="([^"]*)"', a) or [None, ""])[1],
                  "path": unx(p), "copy": "copyfrom-path=" in a} for a, p in re.findall(r"<path\b([^>]*)>([^<]*)</path>", body)]
        out.append({"rev": int(m.group(1)), "author": unx(first(r"<author>([^<]*)</author>")), "date": first(r"<date>([^<]*)</date>"),
                    "msg": unx(first(r"<msg>([\s\S]*?)</msg>")), "paths": paths})
    return out


class SvnCommits:
    """The same for revisions of Subversion. Files are read from the repository by URL, so the working copy
    does not have to be at those revisions. The same as svnCommitProvider() in the extension."""

    def __init__(self, d, items, message):
        self.dir, self.items, self.message = d, items, message.strip()
        self.commits, self.missing, self.touched, self.cache, self.prefix = [], [], {}, {}, ""

    def svn(self, *args):
        return run(["svn", "--non-interactive", *args], self.dir)

    def at(self, path, rev):
        return "^%s/%s@%s" % (self.prefix, path, rev)

    def cat(self, path, rev):
        key = (rev, path)
        if key not in self.cache:
            code, out, _ = (1, b"", "") if rev == 0 else self.svn("cat", self.at(path, rev))
            self.cache[key] = out if code == 0 else None
        return self.cache[key]

    def log(self, *args):
        # the history is read from the repository URL: a working copy that was not updated after a commit does not see it
        code, out, _ = self.svn("log", "--xml", "-v", *args, "^" + (self.prefix or "/"))
        return svn_log(out.decode("utf-8", "replace")) if code == 0 else []

    def changes(self):
        info = self.svn("info", "--xml", ".")[1].decode("utf-8", "replace")
        rel = (re.search(r"<relative-url>([^<]*)</relative-url>", info) or [None, ""])[1].lstrip("^").rstrip("/")
        self.prefix = urllib.parse.unquote(rel)
        entries = {}
        for item in self.items:
            one, span = re.match(r"^r?(\d+)$", item, re.I), re.match(r"^r?(\d+)\s*[:-]\s*r?(\d+)$", item, re.I)
            found = self.log("-r", one.group(1)) if one else self.log("-r", "%d:%d" % tuple(sorted(map(int, span.groups())))) if span else []
            if found:
                entries.update((e["rev"], e) for e in found)
            else:
                self.missing.append(item)
        if self.message:  # --search also looks at authors and paths; only the message counts here
            entries.update((e["rev"], e) for e in self.log("--search", self.message) if self.message.lower() in e["msg"].lower())
        ordered = [entries[r] for r in sorted(entries)]
        self.commits = [{"id": str(e["rev"]), "short": "r%d" % e["rev"], "author": e["author"], "date": e["date"], "subject": (e["msg"].strip().split("\n") or [""])[0]} for e in ordered]
        inside = lambda p: p[len(self.prefix) + 1:] if p.startswith(self.prefix + "/") else None
        for e in ordered:
            files = []
            for p in e["paths"]:
                rel = inside(p["path"])
                if rel is None:
                    continue
                if p["kind"] != "dir":
                    files.append(rel)
                elif p["action"] == "D" or p["copy"]:  # a deleted or copied directory is one entry; `svn list` names its files
                    code, out, _ = self.svn("list", "-R", self.at(rel, e["rev"] - 1 if p["action"] == "D" else e["rev"]))
                    files += ["%s/%s" % (rel, l) for l in out.decode("utf-8", "replace").splitlines() if code == 0 and l and not l.endswith("/")]
            for f in files:
                t = self.touched.setdefault(f, {"base": e["rev"] - 1, "ids": []})
                t["last"] = e["rev"]
                t["ids"].append("r%d" % e["rev"])
        foreign = {}
        if len(ordered) > 1:  # revisions outside the selection between the selected ones: one query for the whole span
            for e in self.log("-r", "%d:%d" % (ordered[0]["rev"], ordered[-1]["rev"])):
                if e["rev"] not in entries:
                    for p in e["paths"]:
                        if inside(p["path"]) is not None:
                            foreign.setdefault(inside(p["path"]), []).append(e["rev"])
        res = []
        for path, t in self.touched.items():
            old, new = self.cat(path, t["base"]), self.cat(path, t["last"])
            if (old is None and new is None) or old == new:
                continue
            res.append({"path": path, "status": "added" if old is None else "deleted" if new is None else "modified", "commits": t["ids"],
                        "foreign": ["r%d" % r for r in foreign.get(path, []) if t["base"] < r < t["last"]]})
        return res

    def old(self, c):
        return self.cat(c["path"], self.touched[c["path"]]["base"])

    def new(self, c):
        return self.cat(c["path"], self.touched[c["path"]]["last"])

    def diff(self, c, context):
        t = self.touched[c["path"]]
        if c["status"] != "modified":
            return None
        code, out, _ = self.svn("diff", "--internal-diff", self.at(c["path"], t["base"]), self.at(c["path"], t["last"]))
        return out if code == 0 and out else None


def data_dir(main, args):
    """Where the review data of the selected source live: .review/ for the working copy, a subfolder for commits."""
    sub = os.path.join("commity", selection_key(parse_list(args.commits), args.message)) if args.commits or args.message else ""
    return os.path.join(main, ".review", sub)


# ---------------------------------------------------------------- changed lines
def parse_diff(text):
    """Changed lines of one file in diff order: dicts with t (+/-), s, o, n, block, before, after;
    plus the hunks with numbered lines for printing. Returns (entries, hunks) or None when there is no hunk."""
    lines = text.split("\n")
    entries, hunks = [], []
    o = n = 1
    block = 0
    fresh = True  # the next changed line starts a new block
    i = 0
    seen = False
    while i < len(lines):
        m = HUNK.match(lines[i])
        i += 1
        if not m:
            continue
        seen = True
        o_start, o_len = int(m.group(1)), 1 if m.group(2) is None else int(m.group(2))
        n_start, n_len = int(m.group(3)), 1 if m.group(4) is None else int(m.group(4))
        first_o = o_start + 1 if o_len == 0 else o_start
        first_n = n_start + 1 if n_len == 0 else n_start
        if first_n > n and first_o > o:  # context lies between this hunk and the previous one
            fresh = True
        o, n = max(o, first_o), max(n, first_n)
        hunk = []
        rem_o, rem_n = o_len, n_len
        while i < len(lines) and (rem_o > 0 or rem_n > 0):
            l = lines[i]
            if l.endswith("\r"):
                l = l[:-1]
            t = l[:1]
            if t == "\\":
                i += 1
                continue
            if t == "+" and rem_n > 0:
                if fresh:
                    block, fresh = block + 1, False
                entries.append({"t": "+", "s": l[1:], "o": None, "n": n, "block": block})
                hunk.append(("+", None, n, l[1:]))
                n += 1
                rem_n -= 1
            elif t == "-" and rem_o > 0:
                if fresh:
                    block, fresh = block + 1, False
                entries.append({"t": "-", "s": l[1:], "o": o, "n": None, "block": block, "before": n - 1, "after": n})
                hunk.append(("-", o, None, l[1:]))
                o += 1
                rem_o -= 1
            elif (t == " " or l == "") and rem_o > 0 and rem_n > 0:
                hunk.append((" ", o, n, l[1:]))
                fresh = True
                o += 1
                n += 1
                rem_o -= 1
                rem_n -= 1
            else:
                break
            i += 1
        hunks.append(hunk)
    return (entries, hunks) if seen else None


def fits(entries, old_count, new_count):
    return old_count + sum(1 if e["t"] == "+" else -1 for e in entries) == new_count


def whole_file(lines, t):
    """Entries for a file that is all added or all deleted (no usable VCS diff)."""
    es = []
    for k, s in enumerate(lines, 1):
        e = {"t": t, "s": s, "o": k if t == "-" else None, "n": k if t == "+" else None, "block": 1}
        if t == "-":
            e.update(before=0, after=1)
        es.append(e)
    return es, [[(t, e["o"], e["n"], e["s"]) for e in es]]


def own_diff(old_lines, new_lines, context):
    """Entries and hunks computed from the content, for a file whose VCS diff is missing or does not fit."""
    import difflib
    entries, hunks, block = [], [], 0
    for group in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_grouped_opcodes(max(context, 0)):
        hunk = []
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                hunk.extend((" ", i1 + k + 1, j1 + k + 1, new_lines[j1 + k]) for k in range(i2 - i1))
                continue
            block += 1
            for k in range(i1, i2):
                entries.append({"t": "-", "s": old_lines[k], "o": k + 1, "n": None, "block": block, "before": j1, "after": j1 + 1})
                hunk.append(("-", k + 1, None, old_lines[k]))
            for k in range(j1, j2):
                entries.append({"t": "+", "s": new_lines[k], "o": None, "n": k + 1, "block": block})
                hunk.append(("+", None, k + 1, new_lines[k]))
        hunks.append(hunk)
    return entries, hunks


def in_range(v, r):
    return v is not None and bool(r) and r.get("od") is not None and r["od"] <= v <= r.get("do", r["od"])


def map_pieces(entries, pieces):
    """The same assignment as mapPieces() in the extension. Returns owner index (into leaves) per entry and the leaves."""
    parents = {p.get("rodic") for p in pieces if p.get("rodic")}
    leaves = [p for p in pieces if p["id"] not in parents]
    owner = [-1] * len(entries)
    for k, p in enumerate(leaves):
        old = p.get("radky") if p.get("strana") == "stara" else p.get("stare")
        new = None if p.get("strana") == "stara" else p.get("radky")
        for i, e in enumerate(entries):
            if owner[i] >= 0:
                continue
            if (e["t"] == "+" and in_range(e["n"], new)) or (e["t"] == "-" and in_range(e["o"], old)):
                owner[i] = k
    for i, e in enumerate(entries):
        if e["t"] != "-" or owner[i] >= 0:
            continue
        for k, p in enumerate(leaves):
            r = p.get("radky")
            if p.get("strana") != "stara" and r and r.get("od") is not None and r["od"] <= e["before"] and e["after"] <= r.get("do", r["od"]):
                owner[i] = k
                break
    for i, e in enumerate(entries):
        if e["t"] != "-" or owner[i] >= 0:
            continue
        found = -1
        j = i + 1
        while j < len(entries) and entries[j]["block"] == e["block"] and found < 0:
            if owner[j] >= 0:
                found = owner[j]
            j += 1
        j = i - 1
        while j >= 0 and entries[j]["block"] == e["block"] and found < 0:
            if owner[j] >= 0:
                found = owner[j]
            j -= 1
        if found >= 0:
            owner[i] = found
    return owner, leaves


def fingerprint(entries):
    return hashlib.sha256("\n".join(e["t"] + e["s"] for e in entries).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- xlsx (values and formulas only)
def read_xlsx(data):
    import io
    sheets = {}
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        names = z.namelist()
        text = lambda n: z.read(n).decode("utf-8", "replace") if n in names else ""
        unx = lambda s: s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&")
        shared = ["".join(unx(t) for t in re.findall(r"<t\b[^>]*>([\s\S]*?)</t>", si)) for si in re.findall(r"<si\b[^>]*>([\s\S]*?)</si>", text("xl/sharedStrings.xml"))]
        rels = {}
        for tag in re.findall(r"<Relationship\b[^>]*>", text("xl/_rels/workbook.xml.rels")):
            rid, target = re.search(r'\bId="([^"]*)"', tag), re.search(r'\bTarget="([^"]*)"', tag)
            if rid and target:
                rels[rid.group(1)] = target.group(1).lstrip("/") if target.group(1).startswith("/") else "xl/" + target.group(1)
        for tag in re.findall(r"<sheet\b[^>]*>", text("xl/workbook.xml")):
            name, rid = re.search(r'\bname="([^"]*)"', tag), re.search(r'\br:id="([^"]*)"', tag)
            cells = {}
            for attrs, inner in re.findall(r"<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)", text(rels.get(rid.group(1), "") if rid else "")):
                ref, typ = re.search(r'\br="([^"]*)"', attrs), re.search(r'\bt="([^"]*)"', attrs)
                v, f = re.search(r"<v\b[^>]*>([\s\S]*?)</v>", inner), re.search(r"<f\b[^>]*?(?:/>|>([\s\S]*?)</f>)", inner)
                val = v.group(1) if v else ""
                if typ and typ.group(1) == "s" and val.isdigit() and int(val) < len(shared):
                    val = shared[int(val)]
                elif typ and typ.group(1) == "inlineStr":
                    val = "".join(re.findall(r"<t\b[^>]*>([\s\S]*?)</t>", inner))
                val = unx(val)
                if f and f.group(1):
                    val = "=%s (%s)" % (unx(f.group(1)), val)
                if ref and val != "":
                    cells[ref.group(1)] = val
            sheets[unx(name.group(1)) if name else "?"] = cells
    except Exception as e:  # noqa: BLE001 - any broken workbook is reported the same way
        return None, str(e)
    return sheets, None


# ---------------------------------------------------------------- xls (BIFF8 in an OLE2 container)
# The same reading as src/core/xls.ts in the extension: cell values and the text of formulas.
XLS_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
XLS_FUNCS = {}
for _item in "0:COUNT 1:IF 2:ISNA/1 3:ISERROR/1 4:SUM 5:AVERAGE 6:MIN 7:MAX 8:ROW 9:COLUMN 10:NA/0 11:NPV 12:STDEV 13:DOLLAR 14:FIXED 15:SIN/1 16:COS/1 17:TAN/1 18:ATAN/1 19:PI/0 20:SQRT/1 21:EXP/1 22:LN/1 23:LOG10/1 24:ABS/1 25:INT/1 26:SIGN/1 27:ROUND/2 28:LOOKUP 29:INDEX 30:REPT/2 31:MID/3 32:LEN/1 33:VALUE/1 34:TRUE/0 35:FALSE/0 36:AND 37:OR 38:NOT/1 39:MOD/2 40:DCOUNT/3 41:DSUM/3 42:DAVERAGE/3 43:DMIN/3 44:DMAX/3 45:DSTDEV/3 46:VAR 47:DVAR/3 48:TEXT/2 49:LINEST 50:TREND 51:LOGEST 52:GROWTH 56:PV 57:FV 58:NPER 59:PMT 60:RATE 61:MIRR/3 62:IRR 63:RAND/0 64:MATCH 65:DATE/3 66:TIME/3 67:DAY/1 68:MONTH/1 69:YEAR/1 70:WEEKDAY 71:HOUR/1 72:MINUTE/1 73:SECOND/1 74:NOW/0 75:AREAS/1 76:ROWS/1 77:COLUMNS/1 78:OFFSET 82:SEARCH 83:TRANSPOSE/1 86:TYPE/1 92:SERIESSUM/4 97:ATAN2/2 98:ASIN/1 99:ACOS/1 100:CHOOSE 101:HLOOKUP 102:VLOOKUP 105:ISREF/1 109:LOG 111:CHAR/1 112:LOWER/1 113:UPPER/1 114:PROPER/1 115:LEFT 116:RIGHT 117:EXACT/2 118:TRIM/1 119:REPLACE/4 120:SUBSTITUTE 121:CODE/1 124:FIND 125:CELL 126:ISERR/1 127:ISTEXT/1 128:ISNUMBER/1 129:ISBLANK/1 130:T/1 131:N/1 140:DATEVALUE/1 141:TIMEVALUE/1 142:SLN/3 143:SYD/4 144:DDB 148:INDIRECT 162:CLEAN/1 163:MDETERM/1 164:MINVERSE/1 165:MMULT/2 167:IPMT 168:PPMT 169:COUNTA 183:PRODUCT 184:FACT/1 189:DPRODUCT/3 190:ISNONTEXT/1 193:STDEVP 194:VARP 195:DSTDEVP/3 196:DVARP/3 197:TRUNC 198:ISLOGICAL/1 199:DCOUNTA/3 204:USDOLLAR 205:FINDB 206:SEARCHB 207:REPLACEB/4 208:LEFTB 209:RIGHTB 210:MIDB/3 211:LENB/1 212:ROUNDUP/2 213:ROUNDDOWN/2 214:ASC/1 215:DBCS/1 216:RANK 219:ADDRESS 220:DAYS360 221:TODAY/0 222:VDB 227:MEDIAN 228:SUMPRODUCT 229:SINH/1 230:COSH/1 231:TANH/1 232:ASINH/1 233:ACOSH/1 234:ATANH/1 235:DGET/3 244:INFO/1 247:DB 252:FREQUENCY/2 261:ERROR.TYPE/1 269:AVEDEV 270:BETADIST 271:GAMMALN/1 272:BETAINV 273:BINOMDIST/4 274:CHIDIST/2 275:CHIINV/2 276:COMBIN/2 277:CONFIDENCE/3 278:CRITBINOM/3 279:EVEN/1 280:EXPONDIST/3 281:FDIST/3 282:FINV/3 283:FISHER/1 284:FISHERINV/1 285:FLOOR/2 286:GAMMADIST/4 287:GAMMAINV/3 288:CEILING/2 289:HYPGEOMDIST/4 290:LOGNORMDIST/3 291:LOGINV/3 292:NEGBINOMDIST/3 293:NORMDIST/4 294:NORMSDIST/1 295:NORMINV/3 296:NORMSINV/1 297:STANDARDIZE/3 298:ODD/1 299:PERMUT/2 300:POISSON/3 301:TDIST/3 302:WEIBULL/4 303:SUMXMY2/2 304:SUMX2MY2/2 305:SUMX2PY2/2 306:CHITEST/2 307:CORREL/2 308:COVAR/2 309:FORECAST/3 310:FTEST/2 311:INTERCEPT/2 312:PEARSON/2 313:RSQ/2 314:STEYX/2 315:SLOPE/2 316:TTEST/4 317:PROB 318:DEVSQ 319:GEOMEAN 320:HARMEAN 321:SUMSQ 322:KURT 323:SKEW 324:ZTEST 325:LARGE/2 326:SMALL/2 327:QUARTILE/2 328:PERCENTILE/2 329:PERCENTRANK 330:MODE 331:TRIMMEAN/2 332:TINV/2 336:CONCATENATE 337:POWER/2 342:RADIANS/1 343:DEGREES/1 344:SUBTOTAL 345:SUMIF 346:COUNTIF/2 347:COUNTBLANK/1 350:ISPMT/4 351:DATEDIF/3 352:DATESTRING/1 353:NUMBERSTRING/2 354:ROMAN 358:GETPIVOTDATA/2 359:HYPERLINK 360:PHONETIC/1 361:AVERAGEA 362:MAXA 363:MINA 364:STDEVPA 365:VARPA 366:STDEVA 367:VARA 368:BAHTTEXT/1 369:THAIDAYOFWEEK/1 370:THAIDIGIT/1 371:THAIMONTHOFYEAR/1 372:THAINUMSOUND/1 373:THAINUMSTRING/1 374:THAISTRINGLENGTH/1 375:ISTHAIDIGIT/1 376:ROUNDBAHTDOWN/1 377:ROUNDBAHTUP/1 378:THAIYEAR/1 379:RTD".split(" "):
    _m = re.match(r"^(\d+):([^/]+)(?:/(\d+))?$", _item)
    XLS_FUNCS[int(_m.group(1))] = (_m.group(2), -1 if _m.group(3) is None else int(_m.group(3)))
XLS_ERRORS = {0x00: "#NULL!", 0x07: "#DIV/0!", 0x0F: "#VALUE!", 0x17: "#REF!", 0x1D: "#NAME?", 0x24: "#NUM!", 0x2A: "#N/A"}
XLS_BINARY = ["+", "-", "*", "/", "^", "&", "<", "<=", "=", ">=", ">", "<>", " ", ",", ":"]
XLS_BUILTIN_NAMES = ["Consolidate_Area", "Auto_Open", "Auto_Close", "Extract", "Database", "Criteria", "Print_Area", "Print_Titles",
                     "Recorder", "Data_Form", "Auto_Activate", "Auto_Deactivate", "Sheet_Title", "_FilterDatabase"]


def cfb_stream(data, names):
    """A stream of an OLE2 compound file by name (the first of names that exists), or None."""
    u16 = lambda o: struct.unpack_from("<H", data, o)[0]
    u32 = lambda o: struct.unpack_from("<I", data, o)[0]
    sec, mini, cutoff, free = 1 << u16(30), 1 << u16(32), u32(56), 0xFFFFFFFC
    at = lambda n: (n + 1) * sec
    fat_secs = [x for x in struct.unpack_from("<109I", data, 76) if x < free]
    n, guard = u32(68), 0
    while n < free and at(n) + sec <= len(data) and guard < 10000:
        fat_secs += [x for x in struct.unpack_from("<%dI" % (sec // 4 - 1), data, at(n)) if x < free]
        n, guard = u32(at(n) + sec - 4), guard + 1
    fat = []
    for n in fat_secs:
        fat += struct.unpack_from("<%dI" % (sec // 4), data, at(n)) if at(n) + sec <= len(data) else [0xFFFFFFFF] * (sec // 4)

    def chain(start, table):
        out = []
        while start < free and start < len(table) and len(out) <= len(table):
            out.append(start)
            start = table[start]
        return out

    big = lambda start, size=None: b"".join(data[at(n):at(n) + sec] for n in chain(start, fat))[:size]
    directory = big(u32(48))
    entries = []
    for o in range(0, len(directory) - 127, 128):
        length = max(0, min(struct.unpack_from("<H", directory, o + 64)[0], 64) - 2)
        start, size = struct.unpack_from("<II", directory, o + 116)
        entries.append((directory[o:o + length].decode("utf-16-le", "replace").lower(), directory[o + 66], start, size))
    for name in names:
        for ename, etype, start, size in entries:
            if etype == 2 and ename == name.lower():
                if size >= cutoff:
                    return big(start, size)
                root = [e for e in entries if e[1] == 5]
                if not root:
                    return None
                mini_stream = big(root[0][2], root[0][3])
                raw = big(u32(60))
                mini_fat = struct.unpack_from("<%dI" % (len(raw) // 4), raw)
                return b"".join(mini_stream[n * mini:n * mini + mini] for n in chain(start, mini_fat))[:size]
    return None


def xls_col(c):
    s = ""
    c += 1
    while c > 0:
        c, r = divmod(c - 1, 26)
        s = chr(65 + r) + s
    return s


def xls_number(x):
    return str(int(x)) if x == x and abs(x) < 1e15 and x == int(x) else repr(x)


def xls_formula(tok, row, col, book, shared, depth=0):
    """Formula tokens of BIFF8 (reverse Polish notation) as text without '='. Raises on a token it does not know."""
    u16 = lambda o: struct.unpack_from("<H", tok, o)[0]
    stack = []

    def cell(r, c, relative):
        col_rel, row_rel, cc, rr = bool(c & 0x4000), bool(c & 0x8000), c & 0xFF, r
        if relative:  # a reference in a shared formula is an offset from the cell with the formula
            if row_rel:
                rr = (row + (r - 0x10000 if r > 0x7FFF else r)) & 0xFFFF
            if col_rel:
                cc = (col + (cc - 0x100 if cc > 0x7F else cc)) & 0xFF
        return ("" if col_rel else "$") + xls_col(cc), ("" if row_rel else "$") + str(rr + 1), rr, cc

    def ref(o, relative):
        a = cell(u16(o), u16(o + 2), relative)
        return a[0] + a[1]

    def area(o, relative):
        a, b = cell(u16(o), u16(o + 4), relative), cell(u16(o + 2), u16(o + 6), relative)
        if a[2] == 0 and b[2] == 0xFFFF:
            return "%s:%s" % (a[0], b[0])
        if a[3] == 0 and b[3] == 0xFF:
            return "%s:%s" % (a[1], b[1])
        return "%s%s:%s%s" % (a[0], a[1], b[0], b[1])

    def quote(name):
        return name if re.match(r"^[^\W\d][\w.]*$", name) else "'%s'" % name.replace("'", "''")

    def sheet(ixti):
        sup, first, last = book["xti"][ixti]
        if not book["supbooks"][sup][0]:
            return "[externí]"
        if first > 0xFFF0 or last > 0xFFF0:
            return "" if first == 0xFFFE else "#REF!"
        a, b = book["sheets"][first], book["sheets"][last]
        return (quote(a) if a == b else quote("%s:%s" % (a, b))) + "!"

    def call(name, argc):
        args = [stack.pop() for _ in range(argc)][::-1]
        stack.append("%s(%s)" % (name, ",".join(args)))

    p = 0
    while p < len(tok):
        op = tok[p]
        p += 1
        base = (op & 0x1F) | 0x20 if op >= 0x20 else op
        if 0x03 <= base <= 0x11:
            b, a = stack.pop(), stack.pop()
            stack.append(a + XLS_BINARY[base - 3] + b)
        elif base == 0x01:  # ptgExp: the formula is shared or an array formula stored at the cell (r, c)
            if depth > 2:
                raise ValueError("shared formula")
            return xls_formula(shared[(u16(p), u16(p + 2))], row, col, book, shared, depth + 1)
        elif base == 0x12:
            stack.append("+" + stack.pop())
        elif base == 0x13:
            stack.append("-" + stack.pop())
        elif base == 0x14:
            stack.append(stack.pop() + "%")
        elif base == 0x15:
            stack.append("(%s)" % stack.pop())
        elif base == 0x16:
            stack.append("")
        elif base == 0x17:
            cch, wide = tok[p], tok[p + 1] & 1
            raw = tok[p + 2:p + 2 + (2 * cch if wide else cch)]
            stack.append('"%s"' % raw.decode("utf-16-le" if wide else "latin-1", "replace").replace('"', '""'))
            p += 2 + len(raw)
        elif base == 0x19:  # ptgAttr: control marks; only the short SUM matters for the text
            flags, w = tok[p], u16(p + 1)
            p += 3 + ((w + 1) * 2 if flags & 0x04 else 0)
            if flags & 0x10:
                call("SUM", 1)
        elif base == 0x1C:
            stack.append(XLS_ERRORS.get(tok[p], "#ERR!"))
            p += 1
        elif base == 0x1D:
            stack.append("TRUE" if tok[p] else "FALSE")
            p += 1
        elif base == 0x1E:
            stack.append(str(u16(p)))
            p += 2
        elif base == 0x1F:
            stack.append(xls_number(struct.unpack_from("<d", tok, p)[0]))
            p += 8
        elif base == 0x20:
            stack.append("{…}")
            p += 7
        elif base == 0x21:
            name, argc = XLS_FUNCS[u16(p)]
            if argc < 0:
                raise ValueError("function")
            p += 2
            call(name, argc)
        elif base == 0x22:
            argc, idx = tok[p] & 0x7F, u16(p + 1) & 0x7FFF
            p += 3
            if idx == 255:  # an add-in function: its name is the first argument
                args = [stack.pop() for _ in range(argc)][::-1]
                stack.append("%s(%s)" % (args[0] if args else "?", ",".join(args[1:])))
            else:
                call(XLS_FUNCS[idx][0] if idx in XLS_FUNCS else "FUNC%d" % idx, argc)
        elif base == 0x23:
            i = u16(p)
            stack.append(book["names"][i - 1] if 0 < i <= len(book["names"]) else "NAME%d" % i)
            p += 4
        elif base == 0x24:
            stack.append(ref(p, False))
            p += 4
        elif base == 0x25:
            stack.append(area(p, False))
            p += 8
        elif base in (0x26, 0x27, 0x28):  # ptgMem*: a wrapper, the expression follows
            p += 6
        elif base == 0x29:
            p += 2
        elif base == 0x2A:
            stack.append("#REF!")
            p += 4
        elif base == 0x2B:
            stack.append("#REF!")
            p += 8
        elif base == 0x2C:
            stack.append(ref(p, True))
            p += 4
        elif base == 0x2D:
            stack.append(area(p, True))
            p += 8
        elif base == 0x39:
            sup, i = book["supbooks"][book["xti"][u16(p)][0]], u16(p + 2)
            names = book["names"] if sup[0] else sup[1]
            stack.append(names[i - 1] if 0 < i <= len(names) else "NAME%d" % i)
            p += 6
        elif base == 0x3A:
            stack.append(sheet(u16(p)) + ref(p + 2, False))
            p += 6
        elif base == 0x3B:
            stack.append(sheet(u16(p)) + area(p + 2, False))
            p += 10
        elif base in (0x3C, 0x3D):
            stack.append(sheet(u16(p)) + "#REF!")
            p += 6 if base == 0x3C else 10
        else:
            raise ValueError("token %02x" % op)
    if len(stack) != 1:
        raise ValueError("formula")
    return stack[0]


def xls_sst(wb, segs):
    """The shared string table. It may continue in CONTINUE records even inside a string; the continued
    characters then start with a new flags byte (another character width)."""
    out, si = [], 0
    p, end = segs[0][0] + 8, segs[0][0] + segs[0][1]
    total = struct.unpack_from("<I", wb, segs[0][0] + 4)[0]
    for _ in range(total):
        while p >= end and si + 1 < len(segs):
            si += 1
            p, end = segs[si][0], segs[si][0] + segs[si][1]
        if p + 3 > end:
            break
        left, flags = struct.unpack_from("<HB", wb, p)
        p += 3
        runs = ext = 0
        if flags & 0x08:
            runs = struct.unpack_from("<H", wb, p)[0]
            p += 2
        if flags & 0x04:
            ext = struct.unpack_from("<I", wb, p)[0]
            p += 4
        wide, parts = flags & 1, []
        while left > 0:
            if p >= end:
                if si + 1 >= len(segs):
                    break
                si += 1
                p, end = segs[si][0], segs[si][0] + segs[si][1]
                wide = wb[p] & 1
                p += 1
            take = min(left, (end - p) // 2 if wide else end - p)
            if take <= 0:
                p = end
                continue
            parts.append(wb[p:p + (2 * take if wide else take)].decode("utf-16-le" if wide else "latin-1", "replace"))
            p += 2 * take if wide else take
            left -= take
        skip = 4 * runs + ext  # formatting runs and phonetics, without a flags byte
        while skip > 0:
            if p >= end:
                if si + 1 >= len(segs):
                    break
                si += 1
                p, end = segs[si][0], segs[si][0] + segs[si][1]
            k = min(skip, end - p)
            p += k
            skip -= k
        out.append("".join(parts))
    return out


def read_xls(data):
    """Sheets of an .xls workbook as {name: {ref: value}}; a formula is '=TEXT (value)'. Returns (sheets, error)."""
    try:
        wb = cfb_stream(data, ["Workbook", "Book"])
        if not wb:
            return None, "no Excel workbook in the file"
        u16 = lambda o: struct.unpack_from("<H", wb, o)[0]
        u32 = lambda o: struct.unpack_from("<I", wb, o)[0]

        def ustr(o, len_bytes):
            cch = wb[o] if len_bytes == 1 else u16(o)
            p = o + len_bytes
            flags = wb[p]
            p += 1 + (2 if flags & 0x08 else 0) + (4 if flags & 0x04 else 0)
            return wb[p:p + (2 * cch if flags & 1 else cch)].decode("utf-16-le" if flags & 1 else "latin-1", "replace")

        def recs(start):
            p = start
            while p + 4 <= len(wb):
                rid, length = struct.unpack_from("<HH", wb, p)
                yield rid, p + 4, length
                p += 4 + length

        if len(wb) < 8 or u16(0) != 0x0809 or u16(4) != 0x0600:
            return None, "a workbook of Excel older than 97"
        bounds, sst_segs, prev = [], None, 0
        book = {"sheets": [], "names": [], "xti": [], "supbooks": []}
        for rid, off, length in recs(0):
            if rid == 0x000A:
                break
            if rid == 0x003C:
                if prev == 0x00FC:
                    sst_segs.append((off, length))
                continue
            prev = rid
            if rid == 0x002F:
                return None, "the workbook is protected by a password"
            if rid == 0x0085:
                bounds.append((u32(off), wb[off + 5], ustr(off + 6, 1)))
            elif rid == 0x00FC:
                sst_segs = [(off, length)]
            elif rid == 0x01AE:
                book["supbooks"].append((length >= 4 and u16(off + 2) == 0x0401, []))
            elif rid == 0x0023 and book["supbooks"]:
                cch, wide = wb[off + 6], wb[off + 7] & 1
                book["supbooks"][-1][1].append(wb[off + 8:off + 8 + (2 * cch if wide else cch)].decode("utf-16-le" if wide else "latin-1", "replace"))
            elif rid == 0x0017:
                for i in range(u16(off)):
                    if 2 + 6 * i + 6 <= length:
                        book["xti"].append(struct.unpack_from("<HHH", wb, off + 2 + 6 * i))
            elif rid == 0x0018:
                cch, wide = wb[off + 3], wb[off + 14] & 1
                name = wb[off + 15:off + 15 + (2 * cch if wide else cch)].decode("utf-16-le" if wide else "latin-1", "replace")
                if u16(off) & 0x20 and name and ord(name[0]) < len(XLS_BUILTIN_NAMES):
                    name = XLS_BUILTIN_NAMES[ord(name[0])]
                book["names"].append(name)
        book["sheets"] = [b[2] for b in bounds]
        sst = xls_sst(wb, sst_segs) if sst_segs else []

        def rk(v):
            if v & 2:
                n = v >> 2
                n = n - 0x40000000 if n >= 0x20000000 else n
            else:
                n = struct.unpack("<d", struct.pack("<II", 0, v & 0xFFFFFFFC))[0]
            return n / 100 if v & 1 else n

        sheets = {}
        for pos, kind, name in bounds:
            if kind != 0:  # charts, macros and modules are no tables
                continue
            cells, shared, formulas, pending, last, first = {}, {}, [], None, None, True
            for rid, off, length in recs(pos):
                if first:
                    first = False
                    if rid != 0x0809:
                        break
                    continue
                if rid == 0x000A:
                    break
                row, col = struct.unpack_from("<HH", wb, off) if length >= 4 else (0, 0)
                ref = xls_col(col) + str(row + 1)
                if rid == 0x00FD:
                    i = u32(off + 6)
                    cells[ref] = sst[i] if i < len(sst) else ""
                elif rid in (0x0204, 0x00D6):
                    cells[ref] = ustr(off + 6, 2)
                elif rid == 0x0203:
                    cells[ref] = xls_number(struct.unpack_from("<d", wb, off + 6)[0])
                elif rid == 0x027E:
                    cells[ref] = xls_number(rk(u32(off + 6)))
                elif rid == 0x00BD:
                    for i in range((length - 6) // 6):
                        cells[xls_col(col + i) + str(row + 1)] = xls_number(rk(u32(off + 6 + 6 * i)))
                elif rid == 0x0205:
                    cells[ref] = XLS_ERRORS.get(wb[off + 6], "#ERR!") if wb[off + 7] else "TRUE" if wb[off + 6] else "FALSE"
                elif rid == 0x0006:
                    special, what, value = u16(off + 12) == 0xFFFF, wb[off + 6], ""
                    if not special:
                        value = xls_number(struct.unpack_from("<d", wb, off + 6)[0])
                    elif what == 1:
                        value = "TRUE" if wb[off + 8] else "FALSE"
                    elif what == 2:
                        value = XLS_ERRORS.get(wb[off + 8], "#ERR!")
                    pending = ref if special and what == 0 else None
                    formulas.append([ref, row, col, wb[off + 22:off + 22 + u16(off + 20)], value])
                    last = (row, col)
                elif rid == 0x0207 and pending:
                    formulas[-1][4] = ustr(off, 2)
                    pending = None
                elif rid in (0x04BC, 0x0221):  # SHRFMLA, ARRAY: the formula several cells point to
                    at = off + (10 if rid == 0x04BC else 14)
                    tok = wb[at:at + u16(at - 2)]
                    shared[(u16(off), wb[off + 4])] = tok
                    if last:
                        shared[last] = tok
            for ref, row, col, tok, value in formulas:
                try:
                    text = xls_formula(tok, row, col, book, shared)
                except Exception:  # noqa: BLE001 - an unknown token: the formula is shown by its fingerprint only
                    text = "(formula %s)" % hashlib.sha256(bytes(tok)).hexdigest()[:8]
                cells[ref] = "=%s (%s)" % (text, value)
            sheets[name] = {r: v for r, v in cells.items() if v != ""}
    except Exception as e:  # noqa: BLE001 - any broken workbook is reported the same way
        return None, str(e) or type(e).__name__
    return sheets, None


def read_workbook(data):
    return read_xls(data) if data[:8] == XLS_SIGNATURE else read_xlsx(data)


def xlsx_changes(old, new):
    a, err_a = read_workbook(old) if old else ({}, None)
    b, err_b = read_workbook(new) if new else ({}, None)
    if a is None or b is None:
        return None, err_a or err_b
    out = []
    for name in list(b) + [n for n in a if n not in b]:
        if name not in a:
            out.append((name, "new sheet", []))
        elif name not in b:
            out.append((name, "removed sheet", []))
        else:
            ca, cb = a[name], b[name]
            key = lambda r: (int(re.sub(r"\D", "", r) or 0), re.sub(r"\d", "", r))
            diff = [(r, ca.get(r, ""), cb.get(r, "")) for r in sorted(set(ca) | set(cb), key=key) if ca.get(r, "") != cb.get(r, "")]
            if diff:
                out.append((name, "changed", diff))
    return out, None


# ---------------------------------------------------------------- collecting
def main_dir(args):
    """The same rule as the extension: one folder is the main directory itself; several folders share the
    directory of the .code-workspace file when they all lie under it, otherwise their common parent."""
    folders = [os.path.abspath(f) for f in (args.folder or [])]
    if not folders and os.environ.get("COPY_AGENT_ROOTS"):
        folders = [os.path.abspath(f) for f in os.environ["COPY_AGENT_ROOTS"].split(os.pathsep) if f]
    if args.main:
        main = os.path.abspath(args.main)
    elif len(folders) > 1:
        main = None
        ws_file = os.environ.get("COPY_AGENT_WORKSPACE_FILE")
        try:
            if ws_file:
                d = os.path.dirname(os.path.abspath(ws_file))
                if all(not os.path.relpath(f, d).startswith("..") for f in folders):
                    main = d
            if main is None:
                main = os.path.commonpath(folders)
                if os.path.dirname(main) == main:  # only the drive root in common
                    main = folders[0]
        except ValueError:  # folders on different drives
            main = folders[0]
    else:
        main = folders[0] if folders else os.getcwd()
    return main, folders or [main]


def git_exclude(main):
    """Keep .review/ out of `git status` through the local .git/info/exclude (never committed)."""
    try:
        p = subprocess.run(["git", "rev-parse", "--git-path", "info/exclude"], cwd=main, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0:
            return
        path = os.path.join(main, p.stdout.decode("utf-8", "replace").strip())
        cur = ""
        if os.path.exists(path):
            with open(path, encoding="utf-8", errors="replace") as fh:
                cur = fh.read()
        if any(l.strip().strip("/") == ".review" for l in cur.splitlines()):
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(("" if not cur or cur.endswith("\n") else "\n") + "# Review změn: data review se necommitují\n.review/\n")
    except OSError:
        pass


def collect(args):
    main, folders = main_dir(args)
    files = []
    roots = find_roots(folders, main, args.depth)
    committed = bool(args.commits or args.message)
    for root in roots:
        if committed:
            prov = (GitCommits if root["vcs"] == "git" else SvnCommits)(root["dir"], parse_list(args.commits), args.message)
        else:
            prov = Git(root["dir"], args.scope) if root["vcs"] == "git" else Svn(root["dir"], args.changelist)
        changes = prov.changes()
        root["commits"], root["missing"] = getattr(prov, "commits", []), getattr(prov, "missing", [])
        for c in sorted(changes, key=lambda c: c["path"]):
            path = (root["prefix"] + "/" if root["prefix"] else "") + c["path"]
            if path == ".review" or path.startswith(".review/") or "/.review/" in path:
                continue
            f = {"path": path, "rel": c["path"], "root": root["name"], "vcs": root["vcs"], "status": c["status"], "kind": "text", "entries": [], "hunks": [],
                 "commits": c.get("commits", []), "foreign": c.get("foreign", [])}
            if c.get("orig"):
                f["orig"] = (root["prefix"] + "/" if root["prefix"] else "") + c["orig"]
            old, new = prov.old(c), prov.new(c)
            if re.search(r"\.(xlsx|xlsm|xls)$", path, re.I):
                f["kind"] = "xlsx"
                f["sheets"], f["error"] = xlsx_changes(old, new)
                if f["sheets"] is None:
                    f["kind"] = "binary"
            elif is_binary(old) or is_binary(new) or max(len(old or b""), len(new or b"")) > 4 * 1024 * 1024:
                f["kind"] = "binary"
            else:
                old_lines, new_lines = split_lines(decode(old, args.encoding)), split_lines(decode(new, args.encoding))
                raw = prov.diff(c, args.context)
                parsed = parse_diff(decode(raw, args.encoding)) if raw else None
                if parsed and fits(parsed[0], len(old_lines), len(new_lines)):
                    f["entries"], f["hunks"] = parsed
                elif not old_lines:
                    f["entries"], f["hunks"] = whole_file(new_lines, "+")
                elif not new_lines:
                    f["entries"], f["hunks"] = whole_file(old_lines, "-")
                else:
                    # The extension falls back to its own diff as well. The two may split a change
                    # differently, so pieces still map by line numbers but get no fingerprint.
                    f["entries"], f["hunks"] = own_diff(old_lines, new_lines, args.context)
                    f["approx"] = True
            files.append(f)
    return main, roots, files


def in_paths(f, paths):
    return not paths or any(f["path"] == p or f["path"].startswith(p + "/") for p in paths)


def listing(main, roots, files, args):
    """The numbered listing of every change, as lines of text."""
    plus = lambda f: sum(1 for e in f["entries"] if e["t"] == "+")
    minus = lambda f: sum(1 for e in f["entries"] if e["t"] == "-")
    out = ["# Changes for review. Main directory: %s" % slash(main),
           "# Working copies: %s" % (", ".join("%s (%s)" % (r["name"], r["vcs"]) for r in roots) or "none found")]
    if args.commits or args.message:
        every = [(r, c) for r in roots for c in r.get("commits", [])]
        missing = [m for m in (roots[0].get("missing", []) if roots else []) if all(m in r.get("missing", []) for r in roots)]
        out.append("# Committed changes%s%s: %d commits, reviewed as one change (each file from before its first to after its last selected commit)."
                   % (" " + ", ".join(parse_list(args.commits)) if args.commits else "", ' with "%s" in the message' % args.message.strip() if args.message else "", len(every)))
        out += ["#   %s %s (%s%s)" % (c["short"], c["subject"], c["author"], ", " + r["name"] if len(roots) > 1 else "") for r, c in every]
        if missing:
            out.append("# Not found: %s" % ", ".join(missing))
        out.append("# Data file: %s (pass the same --commits/--message to check)" % slash(os.path.join(data_dir(main, args), "agent.json")))
    if args.path:
        out.append("# Only: %s" % ", ".join(args.path))
    if not files:
        return out + ["", "No changes."]
    out += ["# %d files, +%d -%d changed lines. Every changed line has to end up in a piece." % (len(files), sum(map(plus, files)), sum(map(minus, files))),
            "# A changed line starts with '+N' (added, N = its NEW line number in the file) or '-N' (removed, N = its OLD",
            "# line number); ' O/N' is unchanged context. Any other numbering is added by the tool that shows you this text.",
            "# Files:"]
    for f in files:
        blocks = len({e["block"] for e in f["entries"]})
        what = "binary" if f["kind"] == "binary" else "workbook" if f["kind"] == "xlsx" else "+%d -%d in %d %s" % (plus(f), minus(f), blocks, "block" if blocks == 1 else "blocks")
        out.append("#   %s [%s] %s" % (f["path"], f["status"], what))
    for f in files:
        out.append("")
        out.append("=== %s [%s, %s%s] +%d -%d" % (f["path"], f["status"], f["vcs"], ", from " + f["orig"] if f.get("orig") else "", plus(f), minus(f)))
        if f.get("foreign"):
            out.append("(commits %s; between them the file was also changed by %s, which are NOT in the selection but are part of this diff)"
                       % (", ".join(f["commits"]), ", ".join(f["foreign"])))
        if f["kind"] == "binary":
            out.append("(binary or too large: do not create a piece for it, the extension shows it on its own)")
            continue
        if f["kind"] == "xlsx":
            for name, state, cells in f["sheets"] or []:
                out.append('sheet "%s": %s%s' % (name, state, " (%d cells)" % len(cells) if cells else ""))
                for ref, a, b in cells[:40]:
                    out.append("  %s: %s -> %s" % (ref, a or "(empty)", b or "(empty)"))
                if len(cells) > 40:
                    out.append("  ... %d more cells" % (len(cells) - 40))
            if not f["sheets"]:
                out.append("(no cell values or formulas changed; formatting only)")
            continue
        if f.get("approx"):
            out.append("(%s gave no usable diff of this file; the changes below are computed from its content)" % f["vcs"])
        shown, total = 0, len(f["entries"])
        full = lambda: bool(args.max_lines) and shown >= args.max_lines and shown < total
        for hunk in f["hunks"]:
            if full():
                break
            out.append("@@")
            for t, o, n, text in hunk:
                if full():
                    break
                if t == " ":
                    out.append(" %5d/%-5d %s" % (o, n, text))
                else:
                    out.append("%s%-11d %s" % (t, n if t == "+" else o, text))
                    shown += 1
        if full():
            out.append("... %d more changed lines of this file are not shown (--max-lines %d); print them with: diff --path %s --max-lines 0%s"
                       % (total - shown, args.max_lines, f["path"], ", or read the file, its line numbers are the same" if f["status"] == "added" else ""))
    return out


def cmd_diff(args):
    main, roots, files = collect(args)
    args.path = [slash(p).strip("/") for p in args.path or []]
    target = os.path.abspath(args.out) if args.out else None
    # the listing file itself is not a change to review
    files = [f for f in files if in_paths(f, args.path) and not (target and os.path.normcase(os.path.join(main, f["path"])) == os.path.normcase(target))]
    lines = listing(main, roots, files, args)
    if not target:
        print("\n".join(lines))
        return 0
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    print("Listing of %d changed files written to %s: %d lines, %d characters." % (len(files), slash(args.out), len(lines), sum(len(l) + 1 for l in lines)))
    print("Read ALL %d lines of it before you write any piece (in line ranges when your tool limits the size)." % len(lines))
    return 0


def plain(v):
    return "".join(ch for ch in unicodedata.normalize("NFD", str(v or "").strip().lower()) if not unicodedata.combining(ch))


def severity(v):
    s = plain(v)
    if s.startswith("vys") or s in ("high", "critical", "kriticka", "blocker"):
        return "vysoka"
    if s.startswith("str") or s in ("medium", "moderate"):
        return "stredni"
    if s.startswith("niz") or s in ("low", "minor", "info"):
        return "nizka"
    return None


def piece_at(lines_of, ids, line):
    """The leaf piece (one of ids) a line number points into: its added line, else its span of lines."""
    for pid in ids:
        if any(e["t"] == "+" and e["n"] == line for e in lines_of.get(pid, [])):
            return pid
    for pid in ids:
        new = [e["n"] for e in lines_of.get(pid, []) if e["n"] is not None]
        old = [e["o"] for e in lines_of.get(pid, []) if e["o"] is not None]
        span = new or old
        if span and min(span) <= line <= max(span):
            return pid
    return None


def check_findings(data, args, files, by_path, pieces, parents, lines_of, file_of, main, roots, errors, warnings):
    """Validates "review" and "nalezy" (the findings of a full review) and normalizes them in place."""
    review, findings = data.get("review"), data.get("nalezy")
    if args.review:
        if not isinstance(review, dict) or not str(review.get("zaver", "")).strip():
            errors.append('--review: "review": {"zaver": "<the verdict in one to three sentences>"} is missing')
        if not isinstance(findings, list):
            errors.append('--review: "nalezy" is missing; it is [] when you found no problem')
    if findings is None:
        return
    if not isinstance(findings, list):
        errors.append('"nalezy" must be a list')
        return
    leaves = [p["id"] for p in pieces if p.get("id") and p["id"] not in parents]
    used = {str(n.get("id")).strip() for n in findings if isinstance(n, dict) and n.get("id")}
    seen, auto = set(), 0
    for n in findings:
        if not isinstance(n, dict):
            errors.append("nalezy: every finding is an object")
            continue
        nid = re.sub(r"\s+", "-", str(n.get("id") or "").strip())
        while not nid:
            auto += 1
            nid = "N%d" % auto if "N%d" % auto not in used else ""
        if nid in seen:
            errors.append("finding %s: duplicate id" % nid)
        seen.add(nid)
        n["id"] = nid
        level = severity(n.get("zavaznost"))
        if not level:
            errors.append("finding %s: zavaznost must be vysoka, stredni or nizka" % nid)
        else:
            n["zavaznost"] = level
        for key, what in (("titulek", "the problem in a few words"), ("popis", "what is wrong and why it matters")):
            if not str(n.get(key, "")).strip():
                errors.append("finding %s: missing %s (%s)" % (nid, key, what))
        line = n.get("radek")
        if line is not None:
            try:
                line = int(line)
            except (TypeError, ValueError):
                line = 0
            if line < 1:
                errors.append("finding %s: radek must be a line number" % nid)
                line = None
            n["radek"] = line
        kus = n.get("kus")
        if kus:
            kus = n["kus"] = str(kus)
            if kus in parents:
                errors.append("finding %s: kus %s is a parent piece; name the leaf piece the finding is about" % (nid, kus))
            elif kus not in leaves:
                errors.append("finding %s: unknown piece %s" % (nid, kus))
            elif not n.get("soubor") and kus in file_of:
                n["soubor"] = file_of[kus]["path"]
        if n.get("soubor"):
            n["soubor"] = slash(str(n["soubor"]))
            if n["soubor"] not in by_path and not os.path.isfile(on_disk(main, roots, n["soubor"])):
                hint = [f["path"] for f in files if f["path"].endswith("/" + n["soubor"]) or f["rel"] == n["soubor"]]
                errors.append("finding %s: file %s does not exist%s" % (nid, n["soubor"], " (did you mean %s?)" % hint[0] if hint else ""))
            elif not kus and line:
                # a finding given only by file and line belongs to the piece that changes that line
                hit = piece_at(lines_of, [pid for pid in leaves if pid in file_of and file_of[pid]["path"] == n["soubor"]], line)
                if hit:
                    n["kus"] = hit
        elif line and not kus:
            warnings.append("finding %s: radek without kus or soubor says nothing; it is reported for the whole change" % nid)


def excerpt(f, own, line, around=3):
    """A few lines of the diff a finding points at, as (t, number, text): around its line, else the start of its piece."""
    if line:
        for removed in (False, True):  # a NEW line number first, then the OLD number of a removed line
            for hunk in f["hunks"]:
                for j, (t, o, n, _text) in enumerate(hunk):
                    if (t == "-" and o == line) if removed else (t != "-" and n == line):
                        return [(t2, o2 if t2 == "-" else n2, s2) for t2, o2, n2, s2 in hunk[max(0, j - around):j + around + 1]]
    return [(e["t"], e["o"] if e["t"] == "-" else e["n"], e["s"]) for e in own[:2 * around + 1]]


def render_review(data, files, pieces, parents, lines_of, file_of, main, roots, report_dir):
    """The review as a readable Markdown report: verdict, table of findings, every finding with its code, the plan."""
    md_dir = report_dir
    by_id = {p["id"]: p for p in pieces if p.get("id")}
    parent_of = {p["id"]: p.get("rodic") for p in pieces if p.get("id")}
    step_of = {}
    for i, st in enumerate(data.get("plan") or [], 1):
        for pid in st.get("kusy", []):
            step_of.setdefault(pid, (i, str(st.get("nazev") or "").strip()))

    def step(pid):
        for _ in range(10):
            if pid in step_of:
                return step_of[pid]
            pid = parent_of.get(pid)
            if not pid:
                break
        return None

    def link(path, line):
        text = "`%s%s`" % (path, ":%d" % line if line else "")
        full = on_disk(main, roots, path)
        if not os.path.isfile(full):  # a file this change deletes
            return text
        return "[%s](%s%s)" % (text, urllib.parse.quote(slash(os.path.relpath(full, md_dir))), "#L%d" % line if line else "")

    def span(pid):
        own = lines_of.get(pid) or []
        new = [e["n"] for e in own if e["n"] is not None]
        nums = new or [e["o"] for e in own if e["o"] is not None]
        if not nums:
            return ""
        return (" ř. " if new else " původní ř. ") + (str(min(nums)) if min(nums) == max(nums) else "%d–%d" % (min(nums), max(nums)))

    cell = lambda v: re.sub(r"\s+", " ", str(v or "")).replace("|", "\\|").strip()
    findings = sorted(data.get("nalezy") or [], key=lambda n: SEVERITIES.index(n["zavaznost"]))
    of_piece = {}
    for n in findings:
        of_piece.setdefault(n.get("kus"), []).append(n["id"])
    leaves = [p for p in pieces if p.get("id") and p["id"] not in parents]
    title = str((data.get("souhrn") or {}).get("titulek") or "").strip() or "necommitnuté změny"
    out = ["# Review změn: %s" % title, "",
           "%s · souborů: %d · kusů: %d · kroků plánu: %d" % (str(data.get("vytvoreno", ""))[:16].replace("T", " "), len(files), len(leaves), len(data.get("plan") or [])), ""]
    verdict = str((data.get("review") or {}).get("zaver") or "").strip()
    if verdict:
        out += ["**Závěr:** %s" % verdict, ""]
    if not findings:
        out += ["**Nálezy:** žádné.", ""]
    else:
        count = lambda level: sum(1 for n in findings if n["zavaznost"] == level)
        out += ["**Nálezy: %d** (%s)" % (len(findings), ", ".join("%s %d" % (SEVERITY_CS[l], count(l)) for l in SEVERITIES)), "",
                "| # | Závažnost | Nález | Kde |", "| --- | --- | --- | --- |"]
        for n in findings:
            where = link(n["soubor"], n.get("radek")) if n.get("soubor") else "celá změna"
            out.append("| %s | %s | %s | %s |" % (n["id"], SEVERITY_CS[n["zavaznost"]], cell(n.get("titulek")), where))
        out += ["", "## Nálezy", ""]
        for n in findings:
            out += ["### %s · %s · %s" % (n["id"], SEVERITY_CS[n["zavaznost"]], cell(n.get("titulek"))), ""]
            where = [link(n["soubor"], n.get("radek"))] if n.get("soubor") else ["celá změna"]
            kus = by_id.get(n.get("kus"))
            if kus:
                where.append("kus „%s“" % cell(kus.get("titulek") or kus["id"]))
                st = step(kus["id"])
                if st:
                    where.append("krok %d %s" % st)
            out += ["**Kde:** %s" % " · ".join(where), "", str(n.get("popis") or "").strip(), ""]
            if str(n.get("navrh") or "").strip():
                out += ["**Návrh:** %s" % str(n["navrh"]).strip(), ""]
            f = file_of.get(n.get("kus"))
            rows = excerpt(f, lines_of.get(n.get("kus")) or [], n["radek"]) if f and f["path"] == n.get("soubor") and n.get("radek") else []
            if rows:
                fence = "~~~" if any("```" in r[2] for r in rows) else "```"
                out += [fence + "diff"] + ["%s%5s  %s" % (t, num if num is not None else "", text[:200]) for t, num, text in rows] + [fence, ""]
    out += ["## Plán revize", ""]
    shown = set()

    def piece_line(p):
        shown.add(p["id"])
        bits = [cell(p.get("titulek") or p["id"]), "`%s`%s" % (p.get("soubor", ""), span(p["id"]))]
        risk = (p.get("riziko") or {}).get("uroven")
        if risk in ("stredni", "vysoke"):
            bits.append("riziko %s" % RISK_CS[risk])
        if of_piece.get(p["id"]):
            bits.append("nálezy: %s" % ", ".join(of_piece[p["id"]]))
        return "   - " + " · ".join(bits)

    def expand(pid, depth=0):
        if pid not in parents:
            return [by_id[pid]] if pid in by_id else []
        return [] if depth > 8 else [q for c in pieces if c.get("rodic") == pid and c.get("id") for q in expand(c["id"], depth + 1)]

    for i, st in enumerate(data.get("plan") or [], 1):
        why = str(st.get("proc") or "").strip()
        out.append("%d. **%s**%s" % (i, cell(st.get("nazev") or "Krok %d" % i), ": " + why if why else ""))
        out += [piece_line(p) for pid in st.get("kusy", []) for p in expand(pid) if p["id"] not in shown]
    rest = [p for p in leaves if p["id"] not in shown]
    if rest:
        out.append("%d. **%s**" % (len(data.get("plan") or []) + 1, "Formátování a kusy mimo plán"))
        out += [piece_line(p) for p in rest]
    return out


def on_disk(main, roots, path):
    """Absolute path of a file given relative to the main directory (a working copy outside it has its name as prefix)."""
    best = None
    for r in roots:
        if r["prefix"] and path.startswith(r["prefix"] + "/") and (best is None or len(r["prefix"]) > len(best["prefix"])):
            best = r
    return os.path.join(best["dir"], path[len(best["prefix"]) + 1:]) if best else os.path.join(main, path)


def cmd_check(args):
    main, roots, files = collect(args)
    target = os.path.join(data_dir(main, args), "agent.json")
    path = os.path.abspath(args.file) if args.file else target
    try:
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except OSError as e:
        print("ERROR: cannot read %s: %s" % (path, e))
        return 1
    except ValueError as e:
        print("ERROR: %s is not valid JSON: %s" % (path, e))
        return 1
    # the validated file itself is not a change to review
    files = [f for f in files if os.path.normcase(os.path.join(main, f["path"])) != os.path.normcase(path)]
    errors, warnings = [], []
    # A change nobody described ends up in the extension as "outside the agent's plan". That is an
    # error unless the user narrowed the scope of the review (--partial).
    gap = warnings if args.partial else errors
    pieces = data.get("kusy")
    if not isinstance(pieces, list) or not pieces:
        print('ERROR: "kusy" must be a non-empty list')
        return 1
    by_path = {f["path"]: f for f in files}
    ids = set()
    for p in pieces:
        pid = p.get("id")
        if not pid or not p.get("soubor"):
            errors.append("piece without id or soubor: %s" % json.dumps(p, ensure_ascii=False)[:120])
            continue
        if pid in ids:
            errors.append("duplicate id %s" % pid)
        ids.add(pid)
        p["soubor"] = slash(p["soubor"])
        if p["soubor"] not in by_path:
            hint = [f["path"] for f in files if f["path"].endswith("/" + p["soubor"]) or f["rel"] == p["soubor"]]
            errors.append("%s: file %s is not among the changes%s" % (pid, p["soubor"], " (did you mean %s?)" % hint[0] if hint else ""))
        if p.get("rodic") and p["rodic"] not in {q.get("id") for q in pieces if q.get("soubor") == p.get("soubor")}:
            errors.append("%s: rodic %s is not a piece of the same file" % (pid, p["rodic"]))
        risk = p.get("riziko")
        if risk:
            level = "".join(ch for ch in unicodedata.normalize("NFD", str(risk.get("uroven", "")).lower()) if not unicodedata.combining(ch))
            level = {"high": "vysoke", "medium": "stredni", "low": "nizke"}.get(level, level)
            if level not in RISKS:
                errors.append("%s: riziko.uroven must be nizke, stredni or vysoke" % pid)
            else:
                risk["uroven"] = level
                if level != "nizke" and not str(risk.get("duvod", "")).strip():
                    warnings.append("%s: riziko %s without duvod" % (pid, level))
        if not str(p.get("titulek", "")).strip():
            warnings.append("%s: missing titulek" % pid)
    covered_total = changed_total = 0
    lines_of, file_of = {}, {}  # leaf piece id -> its changed lines, its file
    for f in files:
        mine = [p for p in pieces if p.get("soubor") == f["path"] and p.get("id")]
        for p in mine:
            file_of[p["id"]] = f
        if f["kind"] == "binary":
            for p in mine:
                warnings.append("%s: %s is binary or too large; the extension shows it on its own and ignores this piece" % (p["id"], f["path"]))
            continue
        if f["kind"] == "xlsx":
            sheet_names = [name for name, _s, _c in f["sheets"] or []]
            for p in mine:
                if p.get("list") not in sheet_names:
                    errors.append('%s: a piece of a workbook needs "list" with the name of a changed sheet (%s)' % (p["id"], ", ".join(sheet_names) or "no sheet changed"))
            for name, _state, _cells in f["sheets"] or []:
                if not any(p.get("list") == name for p in mine):
                    gap.append('%s: sheet "%s" has changes but no piece with "list": "%s"' % (f["path"], name, name))
            continue
        if f["kind"] != "text" or not f["entries"]:
            continue
        owner, leaves = map_pieces(f["entries"], mine)
        changed_total += len(owner)
        for k, p in enumerate(leaves):
            own = lines_of[p["id"]] = [e for i, e in enumerate(f["entries"]) if owner[i] == k]
            if not own:
                errors.append("%s: covers no changed line of %s (radky = NEW line numbers of '+' lines, stare = OLD numbers of '-' lines)" % (p["id"], f["path"]))
            elif f.get("approx"):
                p.pop("otisk", None)  # no diff from the VCS to take the fingerprint from
            else:
                p["otisk"] = fingerprint(own)
        # Uncovered lines of a block that differ only in whitespace are no gap: the extension makes
        # a formatting piece of them by itself, the same way as for "sum": true.
        blocks = {}
        for i, e in enumerate(f["entries"]):
            if owner[i] < 0:
                blocks.setdefault(e["block"], []).append(e)
        squash = lambda es, t: "".join(re.sub(r"\s+", "", e["s"]) for e in es if e["t"] == t)
        loose = [e for es in blocks.values() if squash(es, "+") != squash(es, "-") for e in es]
        covered_total += len(owner) - len(loose)
        if loose and not mine:
            gap.append("%s: changed file without any piece (%d changed lines); see: diff --path %s" % (f["path"], len(loose), f["path"]))
        elif loose:
            spans = sorted({("+%d" % e["n"]) if e["t"] == "+" else ("-%d" % e["o"]) for e in loose}, key=lambda s: (int(s[1:]), s[0] != "-"))
            gap.append("%s: %d changed lines belong to no piece (%s%s); add pieces for them, one piece may span several hunks" % (f["path"], len(loose), ", ".join(spans[:12]), ", ..." if len(spans) > 12 else ""))
    for src in data.get("soubory") or []:
        cesta, zdroj = slash(str(src.get("cesta") or "")), slash(str(src.get("zdroj") or ""))
        if not zdroj:
            continue
        if cesta not in by_path:
            warnings.append("soubory: %s is not among the changes" % cesta)
        # a source deleted by this very change is fine: the extension reads it from the VCS
        if zdroj not in by_path and not os.path.isfile(on_disk(main, roots, zdroj)):
            warnings.append("soubory: source %s of %s does not exist; the extension cannot compare against it" % (zdroj, cesta))
    plan = data.get("plan") or []
    planned = set()
    for s in plan:
        for pid in s.get("kusy", []):
            if pid not in ids:
                errors.append("plan step %s refers to unknown piece %s" % (s.get("krok", "?"), pid))
            planned.add(pid)
        if not str(s.get("nazev", "")).strip():
            warnings.append("plan step %s has no nazev" % s.get("krok", "?"))
    if not plan:
        warnings.append('no "plan": the extension will order pieces by file')
    else:
        parent_of = {p["id"]: p.get("rodic") for p in pieces if p.get("id")}
        parents = set(filter(None, parent_of.values()))

        def is_planned(pid):
            for _ in range(10):
                if pid in planned:
                    return True
                pid = parent_of.get(pid)
                if not pid:
                    return False
            return False
        formatting = {p["id"] for p in pieces if p.get("id") and p.get("sum") is True}
        missing = [pid for pid in parent_of if pid not in parents and pid not in formatting and not is_planned(pid)]
        if missing:
            errors.append("pieces not in any plan step: %s%s" % (", ".join(missing[:15]), ", ..." if len(missing) > 15 else ""))
    all_parents = {p.get("rodic") for p in pieces if p.get("rodic")}
    check_findings(data, args, files, by_path, pieces, all_parents, lines_of, file_of, main, roots, errors, warnings)
    reviewed = isinstance(data.get("review"), dict) or isinstance(data.get("nalezy"), list)
    data["verze"] = 2
    data.setdefault("vytvoreno", datetime.datetime.now().astimezone().isoformat(timespec="seconds"))
    for w in warnings:
        print("warning: " + w)
    for e in errors:
        print("ERROR: " + e)
    report = os.path.join(data_dir(main, args), "review.md")
    if not errors and not args.no_write:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        if os.path.normcase(path) != os.path.normcase(target):
            os.remove(path)
        # the report always matches the data: written with a review, removed without one
        if reviewed:
            with open(report, "w", encoding="utf-8", newline="\n") as fh:
                fh.write("\n".join(render_review(data, files, pieces, all_parents, lines_of, file_of, main, roots, os.path.dirname(report))).rstrip() + "\n")
        elif os.path.exists(report):
            os.remove(report)
        git_exclude(main)
    print("%s: %d pieces, %d plan steps, %d of %d changed lines covered, %d warnings, %d errors%s%s" % (
        "FAILED" if errors else "OK", len(pieces), len(plan), covered_total, changed_total, len(warnings), len(errors),
        "" if errors or args.no_write else "; written with fingerprints to " + slash(target),
        "" if errors or args.no_write or not reviewed else "; review with %d findings written to %s" % (len(data.get("nalezy") or []), slash(report))))
    return 1 if errors else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    ap.add_argument("command", choices=["diff", "check"])
    ap.add_argument("--main")
    ap.add_argument("--folder", action="append")
    ap.add_argument("--depth", type=int, default=2)
    ap.add_argument("--scope", choices=["auto", "staged", "working"], default="auto")
    ap.add_argument("--changelist", default="")
    ap.add_argument("--commits", default="")
    ap.add_argument("--message", default="")
    ap.add_argument("--encoding", default="cp1250")
    ap.add_argument("--context", type=int, default=3)
    ap.add_argument("--max-lines", type=int, default=400)
    ap.add_argument("--path", action="append")
    ap.add_argument("--out")
    ap.add_argument("--file")
    ap.add_argument("--partial", action="store_true")
    ap.add_argument("--review", action="store_true")
    ap.add_argument("--no-write", action="store_true")
    args = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    return cmd_diff(args) if args.command == "diff" else cmd_check(args)


if __name__ == "__main__":
    sys.exit(main())
