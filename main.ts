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
  /** Moves a move edit committed, as [old, new] pairs, for the `R` output lines. */
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

/** A file as lines: its break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileModel {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
/** A line as a tier reads it (SPEC.md section 5). */
function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trailWs(s);
  return trailWs(s).replace(/^[ \t]+/, '');
}

/** Every start position where O's lines match the file's lines at a tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierLine(lines[i + j]!, tier) !== tierLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions, or null. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of an old block O or a new block N: `ctx` marks a context line. */
interface BlockLine {
  text: string;
  ctx: boolean;
}

/**
 * Replace O's lines at `at` by N's lines. A context line of N is written as the file's own
 * matched line; at tier 2 every other line of N is re-indented from O's first line's leading
 * whitespace to the file's first matched line's (SPEC.md section 5).
 */
function applyAt(lines: string[], at: number, o: BlockLine[], n: BlockLine[], tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((e, i) => {
    if (e.ctx) oCtx.push(i);
  });
  const p = o.length > 0 ? leadWs(o[0]!.text) : '';
  const f = o.length > 0 ? leadWs(lines[at]!) : '';
  const out: string[] = [];
  let k = 0;
  for (const e of n) {
    if (e.ctx) {
      out.push(lines[at + oCtx[k]!]!);
      k++;
    } else {
      let t = e.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return [...lines.slice(0, at), ...out, ...lines.slice(at + o.length)];
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'backslash'; text: string; raw?: string };

interface Hunk {
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface UnifiedSection {
  startLine: number;
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** A path as `---`/`+++` write it: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const s = line.slice(4).split('\t')[0]!.trim();
  if (s === '/dev/null') return null;
  return s.replace(/^[ab]\//, '');
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(line: string, lineNo: number): number {
  const m = HUNK_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}

/** Collect a hunk's body starting at `i`; returns the hunk and the next unconsumed index. */
function parseHunkBody(lines: string[], i: number): { hunk: Hunk; next: number } {
  const body: BodyLine[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      if (l.startsWith(' ')) body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l.startsWith('-')) body.push({ kind: 'old', text: l.slice(1) });
      else if (l.startsWith('+')) body.push({ kind: 'new', text: l.slice(1) });
      else if (l.startsWith('\\')) body.push({ kind: 'backslash', text: l.slice(1) });
      else body.push({ kind: 'ctx', text: '' });
      j++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0) {
    const b = body[body.length - 1]!;
    if (b.kind === 'ctx' && b.text === '') body.pop();
    else break;
  }
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      noEol = k + 1 < body.length && body[k + 1]!.kind === 'backslash';
      break;
    }
  }
  return { hunk: { a: 0, body, noEol }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  let sec: UnifiedSection | null = null;
  let inHeader = false;
  const startSection = (oldP: string | null, newP: string | null, diffOld: string | null, diffNew: string | null, startLine: number): void => {
    sec = { startLine, oldPath: oldP, newPath: newP, create: false, del: false, hunks: [] };
    (sec as unknown as { diffOld: string | null; diffNew: string | null }).diffOld = diffOld;
    (sec as unknown as { diffNew: string | null }).diffNew = diffNew;
    sections.push(sec);
    inHeader = true;
  };
  const finishSection = (): void => {
    sec = null;
    inHeader = false;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const rest2 = rest.slice(2);
      const cut = rest2.lastIndexOf(' b/');
      if (cut < 0) throw new Exit2(`error: parse ${i + 1}`);
      const x = rest2.slice(0, cut);
      const y = rest2.slice(cut + 3);
      if (x === '' || y === '') throw new Exit2(`error: parse ${i + 1}`);
      startSection(x, y, x, y, i + 1);
      i++;
      continue;
    }
    if (!inHeader && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(headerPath(l), headerPath(lines[i + 1]!), null, null, i + 1);
      i += 2;
      continue;
    }
    if (sec === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('@@')) {
        const a = parseHunkHeader(l, i + 1);
        const { hunk, next } = parseHunkBody(lines, i + 1);
        hunk.a = a;
        sec.hunks.push(hunk);
        i = next;
        inHeader = false;
        continue;
      }
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.oldPath = headerPath(l);
        sec.newPath = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        sec.newPath = headerPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        (sec as unknown as { renameFrom: string }).renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        (sec as unknown as { renameTo: string }).renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // Between hunks of the same section.
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l, i + 1);
      const { hunk, next } = parseHunkBody(lines, i + 1);
      hunk.a = a;
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      finishSection();
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  const extra = sec as unknown as { diffOld: string | null; diffNew: string | null; renameFrom?: string; renameTo?: string };
  const oldP = sec.oldPath ?? extra.renameFrom ?? extra.diffOld ?? null;
  const newP = sec.newPath ?? extra.renameTo ?? extra.diffNew ?? null;
  const create = sec.create || oldP === null;
  const del = sec.del || newP === null;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (create) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
        if (h.body.some((b) => b.kind === 'new')) noEol = h.noEol;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (del) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) throw new Fail('unsafe', '');
    const move = oldP !== newP;
    if (move) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
    } else if (tree.get(oldP) === null) {
      throw new Fail('missing', oldP);
    }
    const model = parseFile(tree.get(oldP)!);
    let d = 0;
    for (const hunk of sec.hunks) {
      const o: BlockLine[] = [];
      const n: BlockLine[] = [];
      for (const b of hunk.body) {
        if (b.kind === 'ctx') {
          o.push({ text: b.text, ctx: true });
          n.push({ text: b.text, ctx: true });
        } else if (b.kind === 'old') o.push({ text: b.text, ctx: false });
        else if (b.kind === 'new') n.push({ text: b.text, ctx: false });
      }
      if (o.length === 0) {
        const at = Math.min(hunk.a + d, model.lines.length);
        const atEnd = at === model.lines.length;
        const ins = n.map((e) => e.text);
        model.lines = [...model.lines.slice(0, at), ...ins, ...model.lines.slice(at)];
        if (atEnd && ins.length > 0) model.finalBreak = !hunk.noEol;
        d += n.length;
        continue;
      }
      const found = findTier(model.lines, o.map((e) => e.text), strict, 0);
      if (found === null) throw new Fail('no-match', oldP);
      const target = hunk.a - 1 + d;
      let at = found.occ[0]!;
      let best = Math.abs(at - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          at = p;
        }
      }
      const endsAtEnd = at + o.length === model.lines.length;
      model.lines = applyAt(model.lines, at, o, n, found.tier);
      if (endsAtEnd) model.finalBreak = !hunk.noEol;
      d += n.length - o.length;
    }
    const text = renderFile(model);
    if (move) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

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

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (eq === -1 && l.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq !== -1 && l.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (eq === -1 && l.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = parseFile(cur);
    const found = findTier(model.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const o: BlockLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
    const n: BlockLine[] = newLines.map((t) => ({ text: t, ctx: false }));
    const next = { ...model, lines: applyAt(model.lines, found.occ[0]!, o, n, found.tier) };
    tree.now.set(path, renderFile(next));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const V4A_ADD = '*** Add File:';
const V4A_DEL = '*** Delete File:';
const V4A_UPD = '*** Update File:';
const V4A_MOVE = '*** Move to:';

function isV4aSectionStart(l: string): boolean {
  return l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith(V4A_ADD)) {
      const path = l.slice(V4A_ADD.length).trim();
      const fileLines: string[] = [];
      let j = i + 1;
      while (j < last) {
        const m = lines[j]!;
        if (isV4aSectionStart(m) || m.trim() === '*** End Patch') break;
        if (m.startsWith('*** ')) throw new Exit2(`error: parse ${j + 1}`);
        if (m === '') {
          fileLines.push('');
          j++;
          continue;
        }
        if (m.startsWith('+')) {
          fileLines.push(m.slice(1));
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith(V4A_DEL)) {
      const path = l.slice(V4A_DEL.length).trim();
      let j = i + 1;
      while (j < last) {
        const m = lines[j]!;
        if (blank(m)) {
          j++;
          continue;
        }
        if (isV4aSectionStart(m) || m.trim() === '*** End Patch') break;
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith(V4A_UPD)) {
      const path = l.slice(V4A_UPD.length).trim();
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let j = i + 1;
      let closedByEof = false;
      while (j < last) {
        const m = lines[j]!;
        if (isV4aSectionStart(m) || m.trim() === '*** End Patch') break;
        if (m.startsWith(V4A_MOVE)) {
          if (cur !== null || moveTo !== null || chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
          moveTo = m.slice(V4A_MOVE.length).trim();
          j++;
          continue;
        }
        if (m === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          closedByEof = true;
          j++;
          continue;
        }
        if (m.startsWith('@@')) {
          if (cur !== null) {
            chunks.push(cur);
            closedByEof = false;
          }
          cur = { anchor: m.slice(2).trim(), body: [], eof: false };
          j++;
          continue;
        }
        if (m.startsWith('*** ')) throw new Exit2(`error: parse ${j + 1}`);
        if (m === '' || m.startsWith(' ') || m.startsWith('-') || m.startsWith('+')) {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            closedByEof = false;
          }
          if (m === '') cur.body.push({ kind: 'ctx', text: '', raw: m });
          else if (m.startsWith(' ')) cur.body.push({ kind: 'ctx', text: m.slice(1), raw: m });
          else if (m.startsWith('-')) cur.body.push({ kind: 'old', text: m.slice(1), raw: m });
          else cur.body.push({ kind: 'new', text: m.slice(1), raw: m });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) {
        chunks.push(cur);
        closedByEof = false;
      }
      // Blank lines at the end of a section are not part of it (unless the last chunk
      // was closed by `*** End of File`, whose blanks sit before that line, not the section end).
      if (chunks.length > 0 && !closedByEof) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === 'ctx' && b.raw.trim() === '') lastChunk.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let foundAt: number | null = null;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && foundAt === null; t++) {
          for (let k = cursor; k < model.lines.length; k++) {
            if (tierLine(model.lines[k]!, t) === tierLine(chunk.anchor, t)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const o: BlockLine[] = [];
      const n: BlockLine[] = [];
      for (const b of chunk.body) {
        if (b.kind === 'ctx') {
          o.push({ text: b.text, ctx: true });
          n.push({ text: b.text, ctx: true });
        } else if (b.kind === 'old') o.push({ text: b.text, ctx: false });
        else if (b.kind === 'new') n.push({ text: b.text, ctx: false });
      }
      if (o.length === 0) {
        const at = chunk.eof ? model.lines.length : cursor;
        const ins = n.map((e) => e.text);
        model.lines = [...model.lines.slice(0, at), ...ins, ...model.lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      const oTexts = o.map((e) => e.text);
      let found: { tier: number; occ: number[] } | null = null;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top; t++) {
        const occ = occurrences(model.lines, oTexts, t, cursor);
        if (occ.length > 0) {
          found = { tier: t, occ };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      let at = found.occ[0]!;
      if (chunk.eof) {
        const endAt = model.lines.length - o.length;
        if (at !== endAt) {
          if (!found.occ.includes(endAt)) throw new Fail('no-match', path);
          at = endAt;
        }
      }
      model.lines = applyAt(model.lines, at, o, n, found.tier);
      cursor = at + n.length;
    }
    const text = renderFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Write every change (unless --check), then report rows: one per changed path, in
  // byte order; a move replaces its D and A lines with one `R <old> -> <new>` line
  // that sorts by <new> (SPEC.md section 2).
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  const rows: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
