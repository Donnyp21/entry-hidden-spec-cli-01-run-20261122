// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- files as lines (SPEC section 3) ----

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// ---- three-tier line matching (SPEC section 5) ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0..2, or 0 only with --strict) with an occurrence at/after `from`; an end-of-file chunk only takes occurrences ending at the last line. */
function findTierFrom(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    let occ = occurrencesAt(lines, o, t, from);
    if (eof) occ = occ.filter((p) => p + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function findTierSingle(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

interface BL {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** N with context lines taken from the file's own matched lines, other lines re-indented at tier 2. */
function buildReplacement(o: BL[], n: BL[], fileLines: string[], pos: number, tier: number): string[] {
  const oCtxIdx: number[] = [];
  o.forEach((e, i) => {
    if (e.kind === 'ctx') oCtxIdx.push(i);
  });
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(o.length > 0 ? o[0]!.text : '');
  const out: string[] = [];
  let ci = 0;
  for (const e of n) {
    if (e.kind === 'ctx') {
      out.push(fileLines[pos + oCtxIdx[ci]!]!);
      ci += 1;
    } else {
      let t = e.text;
      if (tier === 2 && t !== '' && !onlyWs(t) && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

// ---- unified diffs (SPEC section 6) ----

interface Hunk {
  a: number;
  body: BL[];
}

interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hasHunk: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, surrounding spaces removed, leading a/ or b/ removed, /dev/null as null. */
function uniPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFFGIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(h: Hunk): boolean {
  let last = -1;
  h.body.forEach((b, i) => {
    if (b.kind === 'ctx' || b.kind === 'new') last = i;
  });
  if (last < 0) return false;
  return h.body[last + 1]?.kind === 'bs';
}

function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const m = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const o = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'old');
    const n = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'new');
    const oTexts = o.map((b) => b.text);
    if (oTexts.length > 0) {
      const found = findTierFrom(m.lines, oTexts, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const nTexts = buildReplacement(o, n, m.lines, best, found.tier);
      const toEnd = best + oTexts.length === m.lines.length;
      m.lines.splice(best, oTexts.length, ...nTexts);
      if (toEnd) m.final = !backslashAfterLast(h);
      d += nTexts.length - oTexts.length;
    } else {
      const nTexts = n.map((b) => b.text);
      const at = Math.max(0, Math.min(h.a + d, m.lines.length));
      const atEnd = at === m.lines.length;
      m.lines.splice(at, 0, ...nTexts);
      if (atEnd) m.final = !backslashAfterLast(h);
      d += nTexts.length;
    }
  }
  return joinFile(m);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hunk: Hunk | null = null;
  const fresh = (diffOld?: string, diffNew?: string): UniSection => ({
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld,
    diffNew,
    isNew: false,
    isDeleted: false,
    hasHunk: false,
    hunks: [],
  });
  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      hunk = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        endBody();
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
      } else if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        hunk.body.push({
          kind: line === '' ? 'ctx' : line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'bs',
          text: line === '' ? '' : line.slice(1),
        });
        continue;
      } else {
        endBody();
      }
    }
    if (line.startsWith('diff --git ') || line === 'diff --git') {
      const m = DIFFGIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(m[1], m[2]);
      sections.push(cur);
      continue;
    }
    if (line.startsWith('--- ')) {
      const nxt = lines[i + 1];
      if (nxt !== undefined && nxt.startsWith('+++ ')) {
        if (cur === null || cur.hasHunk) {
          cur = fresh();
          sections.push(cur);
        }
        cur.pairOld = uniPath(line);
        cur.pairNew = uniPath(nxt);
        i += 1;
        continue;
      }
      if (cur !== null && !cur.hasHunk) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.hasHunk = true;
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.isNew = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.isDeleted = true;
      continue;
    }
  }
  endBody();
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const isCreate = oldP === null || sec.isNew;
  const isDelete = !isCreate && (newP === null || sec.isDeleted);
  if (isCreate) {
    return (tree) => {
      if (newP === null || newP === undefined) throw new Fail('unsafe', '/dev/null');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') out.push(b.text);
      let finalBreak = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        let lastPlus = -1;
        h.body.forEach((b, i) => {
          if (b.kind === 'new') lastPlus = i;
        });
        if (lastPlus >= 0) {
          finalBreak = h.body[lastPlus + 1]?.kind !== 'bs';
          break;
        }
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (oldP === null || oldP === undefined) throw new Fail('missing', '/dev/null');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      const op = oldP!;
      const np = newP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyUnifiedHunks(cur, sec.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    };
  }
  return (tree) => {
    const op = oldP!;
    if (!safe(op)) throw new Fail('unsafe', op);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    tree.now.set(op, applyUnifiedHunks(cur, sec.hunks, strict, op));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

interface SRBlock {
  path: string;
  old: string[];
  next: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
        path = prevPath;
      }
      let k = -1;
      for (let m = i + 1; m < lines.length; m++) {
        if (lines[m]!.trimEnd() === '=======') {
          k = m;
          break;
        }
      }
      if (k < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      let r = -1;
      for (let m = k + 1; m < lines.length; m++) {
        if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') {
          r = m;
          break;
        }
      }
      if (r < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      blocks.push({ path, old: lines.slice(i + 1, k), next: lines.slice(k + 1, r) });
      prevPath = path;
      prevEnd = r + 1;
      i = r + 1;
    } else {
      i += 1;
    }
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.next.length === 0 ? '' : b.next.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const m = splitFile(cur);
    const found = findTierFrom(m.lines, b.old, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const nTexts = buildReplacement(
      b.old.map((t) => ({ kind: 'old' as const, text: t })),
      b.next.map((t) => ({ kind: 'new' as const, text: t })),
      m.lines,
      pos,
      found.tier,
    );
    m.lines.splice(pos, b.old.length, ...nTexts);
    tree.now.set(b.path, joinFile(m));
  };
}

// ---- V4A patches (SPEC section 8) ----

interface V4AChunk {
  anchor: string;
  eof: boolean;
  body: BL[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice('*** Delete File: '.length).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice('*** Update File: '.length).trim() };
    return null;
  };
  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  let raw: { text: string; num: number }[] = [];
  const finalize = (): void => {
    if (cur === null) return;
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (cur.kind === 'add') {
      for (const r of raw) {
        if (r.text === '') cur.addLines.push('');
        else if (r.text.startsWith('+')) cur.addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
    } else if (cur.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
    } else {
      let moveTo: string | null = null;
      let chunk: V4AChunk | null = null;
      for (let idx = 0; idx < raw.length; idx++) {
        const r = raw[idx]!;
        const t = r.text;
        if (idx === 0 && t.startsWith('*** Move to: ')) {
          moveTo = t.slice('*** Move to: '.length).trim();
          continue;
        }
        if (t.startsWith('@@')) {
          chunk = { anchor: t.slice(2).trim(), eof: false, body: [] };
          cur.chunks.push(chunk);
          continue;
        }
        if (t === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.num}`);
          chunk.eof = true;
          chunk = null;
          continue;
        }
        if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (chunk === null) {
            if (cur.chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
            chunk = { anchor: '', eof: false, body: [] };
            cur.chunks.push(chunk);
          }
          chunk.body.push({
            kind: t === '' ? 'ctx' : t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new',
            text: t === '' ? '' : t.slice(1),
          });
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (cur.chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${cur.line}`);
      cur.moveTo = moveTo;
    }
    sections.push(cur);
    cur = null;
    raw = [];
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const st = sectionStart(line);
    if (st !== null) {
      finalize();
      cur = { kind: st.kind, path: st.path, line: i + 1, moveTo: null, addLines: [], chunks: [] };
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    raw.push({ text: line, num: i + 1 });
  }
  finalize();
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4ASection, strict: boolean): Edit {
  if (s.kind === 'add') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const m = splitFile(cur);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== '') {
        const at = findTierSingle(m.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const o = ch.body.filter((b) => b.kind === 'ctx' || b.kind === 'old');
      const n = ch.body.filter((b) => b.kind === 'ctx' || b.kind === 'new');
      const oTexts = o.map((b) => b.text);
      if (oTexts.length > 0) {
        const found = findTierFrom(m.lines, oTexts, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', s.path);
        const pos = found.occ[0]!;
        const nTexts = buildReplacement(o, n, m.lines, pos, found.tier);
        m.lines.splice(pos, oTexts.length, ...nTexts);
        cursor = pos + nTexts.length;
      } else {
        const at = ch.eof ? m.lines.length : cursor;
        const nTexts = n.map((b) => b.text);
        m.lines.splice(at, 0, ...nTexts);
        cursor = at + nTexts.length;
      }
    }
    const out = joinFile(m);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // R lines follow whole move chains (SPEC section 2): a file moved A -> B -> C
  // in one patch is reported once, R A -> C, not as D A + A C. A chain starts at
  // a path that existed before the patch and ends at a path that did not; the
  // middle paths existed neither before nor after, so they list nothing.
  const moveTo = new Map<string, string>();
  for (const [o, n] of tree.moves) moveTo.set(o, n);
  const movePairs: Array<[string, string]> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const s of [...tree.now.keys()]) {
    if (tree.original(s) === null || tree.get(s) !== null || !moveTo.has(s)) continue;
    const chain: string[] = [s];
    let cur = s;
    let end: string | null = null;
    while (moveTo.has(cur)) {
      const nxt = moveTo.get(cur)!;
      if (tree.get(nxt) !== null && tree.original(nxt) === null) {
        end = nxt;
        break;
      }
      if (tree.get(nxt) === null && tree.original(nxt) === null) {
        chain.push(nxt);
        cur = nxt;
        continue;
      }
      break;
    }
    if (end === null) continue;
    movePairs.push([s, end]);
    for (const p of chain) {
      movedOld.add(p);
      movedNew.add(p);
    }
    movedNew.add(end);
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of movePairs) rows.push({ key: n, text: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || Buffer.compare(Buffer.from(a.text), Buffer.from(b.text)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
