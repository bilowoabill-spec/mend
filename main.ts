// mend: apply the edits an AI model wrote to a tree of text files.
//
// One command, four patch formats (unified diff, SEARCH/REPLACE blocks, V4A
// patches, JSON tool-call edits), all-or-nothing writes, three tiers of line
// matching for drifted whitespace and indentation. SPEC.md is the contract
// and this file is the whole implementation of it. Node 22, standard library
// only; run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A failure that ends the run with exit 2 and exactly this line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that could not be applied; reported on exit 1, one line each. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** Patch lines the way SPEC section 3 says: split at \n, one trailing \r off each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, plus its own line break and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** A fresh file: LF breaks, ending with one when it has any lines. */
function newDoc(lines: string[]): Doc {
  return { lines, br: '\n', final: lines.length > 0 };
}

const leadWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

/** One line as a tier sees it: exact, trailing space/tab off, or both ends off. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchesAt(file: string[], o: string[], i: number, tier: number): boolean {
  for (let j = 0; j < o.length; j += 1) {
    if (normLine(o[j]!, tier) !== normLine(file[i + j]!, tier)) return false;
  }
  return true;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`, with every such position. */
function findTier(file: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const nf = file.map((l) => normLine(l, t));
    const no = o.map((l) => normLine(l, t));
    const occ: number[] = [];
    for (let i = from; i + o.length <= file.length; i += 1) {
      let ok = true;
      for (let j = 0; j < no.length; j += 1) {
        if (nf[i + j] !== no[j]) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * The lines that replace a match at `pos`: a context line is the file's own
 * matched line, never the patch's; at tier 2 every other line is re-indented
 * from O's first line's leading whitespace to the file's.
 */
function buildReplacement(file: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const fLead = leadWS(file[pos] ?? '');
  const pLead = leadWS(o[0] ?? '');
  return n.map((e) => {
    if (e.ctx) return file[pos + e.oIdx]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(pLead)) return fLead + t.slice(pLead.length);
    }
    return e.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  read(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.read(p);
  }
}

type Edit = (tree: Tree) => void;

/** Section 4: which format a patch is, or null when none of the four holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 9: JSON edits ----

/** One JSON edit object (SPEC section 9), or null when the value is not one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const body = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = body.indexOf(old); k >= 0; k = body.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = body.indexOf(old);
      const out = body.slice(0, at) + toLf(newStr) + body.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const added = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(lineNo, 0, ...added);
      tree.now.set(p, renderDoc(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
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
    for (const item of v) {
      const e = jsonEditObject(item);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Sections 5 and 6: unified diffs ----

/** A hunk's body split into the lines it matches (O) and the lines it writes (N). */
interface BodySplit {
  o: string[];
  n: NewLine[];
  eolAfterLastOut: boolean;
  eolAfterLastPlus: boolean;
}

/** Split hunk body lines into O and N; a `\` line belongs to neither. For a unified body, empty lines at the end are not part of it. */
function splitUnifiedBody(raw: string[]): BodySplit {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '') end -= 1;
  return splitBodyLines(raw.slice(0, end));
}

/** Split body lines (context, `-`, `+`) into O and N, remembering whether a `\` line follows the last context/`+` line and the last `+` line. */
function splitBodyLines(lines: string[]): BodySplit {
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastOut = -1;
  let lastPlus = -1;
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k]!;
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIdx: o.length - 1 });
      lastOut = k;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastOut = k;
      lastPlus = k;
    }
  }
  const after = (k: number): boolean => k >= 0 && lines[k + 1] !== undefined && lines[k + 1]![0] === '\\';
  return { o, n, eolAfterLastOut: after(lastOut), eolAfterLastPlus: after(lastPlus) };
}

interface Hunk extends BodySplit {
  a: number;
}

interface UniSection {
  oldRaw: string;
  newRaw: string;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let sec: {
    pairOld?: string;
    pairNew?: string;
    renOld?: string;
    renNew?: string;
    gitOld: string;
    gitNew: string;
    hasPair: boolean;
    isNew: boolean;
    isDel: boolean;
    hunks: Hunk[];
  } | null = null;
  let header = false;
  let hunk: { a: number; body: string[] } | null = null;

  const closeHunk = (): void => {
    if (hunk !== null && sec !== null) sec.hunks.push({ a: hunk.a, ...splitUnifiedBody(hunk.body) });
    hunk = null;
  };
  const closeSection = (): void => {
    closeHunk();
    if (sec !== null) {
      sections.push({
        oldRaw: sec.pairOld ?? sec.renOld ?? sec.gitOld,
        newRaw: sec.pairNew ?? sec.renNew ?? sec.gitNew,
        isNew: sec.isNew,
        isDel: sec.isDel,
        hunks: sec.hunks,
      });
    }
    sec = null;
    header = false;
  };
  const headerPath = (line: string): string => {
    const rest = line.slice(4);
    const tab = rest.indexOf('\t');
    const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
    return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (hunk !== null) {
      const pairEndsBody = line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ');
      const bodyLine = line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
      if (!pairEndsBody && bodyLine) {
        hunk.body.push(line);
        continue;
      }
      closeHunk();
    }
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeSection();
      sec = { gitOld: m[1]!, gitNew: m[2]!, hasPair: false, isNew: false, isDel: false, hunks: [] };
      header = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      header = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (next !== undefined && next.startsWith('+++ ')) {
        if (sec !== null && header && !sec.hasPair) {
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(next);
          sec.hasPair = true;
          i += 1;
          continue;
        }
        closeSection();
        sec = { gitOld: '', gitNew: '', hasPair: true, isNew: false, isDel: false, hunks: [] };
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(next);
        header = true;
        i += 1;
        continue;
      }
      if (sec !== null && header) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (sec !== null && header) {
      if (line.startsWith('rename from ')) sec.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.isNew = true;
      else if (line.startsWith('deleted file mode')) sec.isDel = true;
      continue;
    }
  }
  closeSection();
  return sections;
}

/** Apply a section's hunks in order to a file's lines, tracking the running offset d. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(h.a + d, doc.lines.length);
      const atEnd = at === doc.lines.length;
      const ins = buildReplacement(doc.lines, at, h.o, h.n, 0);
      doc.lines.splice(at, 0, ...ins);
      if (atEnd) doc.final = !h.eolAfterLastOut;
      d += h.n.length;
    } else {
      const found = findTier(doc.lines, h.o, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const touchesEnd = best + h.o.length === doc.lines.length;
      const repl = buildReplacement(doc.lines, best, h.o, h.n, found.tier);
      doc.lines.splice(best, h.o.length, ...repl);
      if (touchesEnd) doc.final = !h.eolAfterLastOut;
      d += h.n.length - h.o.length;
    }
  }
}

function unifiedEdit(sec: UniSection, strict: boolean, moves: [string, string][]): Edit {
  return (tree) => {
    const oldP = sec.oldRaw === '/dev/null' ? null : sec.oldRaw;
    const newP = sec.newRaw === '/dev/null' ? null : sec.newRaw;
    if (sec.isNew || oldP === null) {
      if (newP === null) return;
      if (!safePath(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const made: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const e of h.n) if (!e.ctx) made.push(e.text);
        if (h.n.some((e) => !e.ctx)) noEol = h.eolAfterLastPlus;
      }
      const doc = newDoc(made);
      if (made.length > 0) doc.final = !noEol;
      tree.now.set(newP, renderDoc(doc));
      return;
    }
    if (sec.isDel || newP === null) {
      if (oldP === null) return;
      if (!safePath(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safePath(oldP)) throw new Fail('unsafe', oldP);
      if (!safePath(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = parseDoc(before);
      applyHunks(doc, sec.hunks, strict, oldP);
      tree.now.set(newP, renderDoc(doc));
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
      return;
    }
    if (!safePath(oldP)) throw new Fail('unsafe', oldP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    const doc = parseDoc(text);
    applyHunks(doc, sec.hunks, strict, oldP);
    tree.now.set(oldP, renderDoc(doc));
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, renderDoc(newDoc(newLines)));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = parseDoc(text);
    const found = findTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const repl = buildReplacement(
      doc.lines,
      pos,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
      found.tier,
    );
    doc.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, renderDoc(doc));
  };
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

const isV4aSectionStart = (line: string): boolean =>
  line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && isBlank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    if (!isV4aSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const headNo = i + 1;
    i += 1;
    let end = i;
    while (end < last && !isV4aSectionStart(lines[end]!)) end += 1;
    while (end > i && isBlank(lines[end - 1]!)) end -= 1;
    const body = lines.slice(i, end);
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const made: string[] = [];
      for (let k = 0; k < body.length; k += 1) {
        const l = body[k]!;
        if (l === '') made.push('');
        else if (l[0] === '+') made.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + k + 1}`);
      }
      edits.push(v4aAddEdit(path, made));
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      if (body.length > 0) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      const path = line.slice(17).trim();
      let moveTo: string | null = null;
      let j = 0;
      if (j < body.length && body[j]!.startsWith('*** Move to: ')) {
        moveTo = body[j]!.slice(13).trim();
        j += 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          const split = splitBodyLines(cur.body);
          chunks.push({ anchor: cur.anchor, o: split.o, n: split.n, eof: cur.eof });
        }
        cur = null;
      };
      for (; j < body.length; j += 1) {
        const l = body[j]!;
        if (l.startsWith('@@')) {
          closeChunk();
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, body: [], eof: false };
        } else if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + j + 1}`);
          cur.eof = true;
          closeChunk();
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null && chunks.length > 0) throw new Exit2(`error: parse ${i + j + 1}`);
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(l);
        } else {
          throw new Exit2(`error: parse ${i + j + 1}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
    }
    i = end;
  }
  return edits;
}

function v4aAddEdit(path: string, made: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, renderDoc(newDoc(made)));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: [string, string][]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(doc.lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const ins = buildReplacement(doc.lines, at, ch.o, ch.n, 0);
        doc.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else if (ch.eof) {
        const at = doc.lines.length - ch.o.length;
        if (at < cursor) throw new Fail('no-match', path);
        let tier: number | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          if (matchesAt(doc.lines, ch.o, at, t)) {
            tier = t;
            break;
          }
        }
        if (tier === null) throw new Fail('no-match', path);
        const repl = buildReplacement(doc.lines, at, ch.o, ch.n, tier);
        doc.lines.splice(at, ch.o.length, ...repl);
        cursor = at + repl.length;
      } else {
        const found = findTier(doc.lines, ch.o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const repl = buildReplacement(doc.lines, pos, ch.o, ch.n, found.tier);
        doc.lines.splice(pos, ch.o.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = renderDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---- Section 1, 2 and 10: invocation, output, order and atomicity ----

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
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict, moves));
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
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
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const byPath = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; text: string }[] = [];
  const spent = new Set<string>();
  for (const [o, n] of moves) {
    if (tree.read(o) !== null && tree.get(o) === null && tree.read(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      spent.add(o);
      spent.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort(byPath)) {
    const was = tree.read(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (spent.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byPath(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byPath)) {
      const was = tree.read(p);
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
