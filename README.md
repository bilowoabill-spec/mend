# mend

`mend` applies the edits an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all of them: a unified diff
(often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON. Every file is changed or nothing is.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory
  (the root of the tree). When it is absent or `-`, the patch is read from
  standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a`, or `json`. `auto` (the default) detects it: a
  `*** Begin Patch` first line means V4A, a leading `[` or `{` means JSON, a
  `<<<<<<< SEARCH` line means SEARCH/REPLACE, and a `diff --git` line or a
  `---`/`+++` pair means a unified diff.
- `--check` does everything but write: same output and exit code, no file
  created, changed, or deleted.
- `--strict` matches lines exactly, with no whitespace forgiveness.
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

Old lines are found at the first of three tiers at which they occur at
least once: exact, trailing spaces/tabs ignored, then leading and trailing
spaces/tabs ignored. At the loosest tier, replacement lines are re-indented
from the patch's indentation to the file's own. A context line is always
written as the file's own line, never the patch's.

## Output and exit codes

- Exit `0`: one line per changed path (`A` added, `D` deleted, `M`
  modified, `R old -> new` moved), then `ok: <n> files`.
- Exit `1`: one `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then
  `failed: <k> of <n> edits`. No file is written.
- Exit `2`: exactly one line — `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>` — and nothing is written.

Edits apply in patch order to the tree as earlier edits left it, so a file
created, changed, moved, or deleted by one edit is seen that way by the
next. A failed edit changes nothing, and the edits after it still run.

## Line endings

A file keeps its own line break (CRLF or LF, taken from its first line)
and its final line break, except where a unified hunk's
`\ No newline at end of file` says otherwise. Files an edit creates are
written with LF breaks. A JSON `create` writes its `file_text` byte for
byte.

## Formats

### Unified diff

Sections start at `diff --git a/<old> b/<new>` or at a `---`/`+++` pair.
Headers may carry `rename from`/`rename to`, `new file mode`, and
`deleted file mode`. Hunks apply in order; when line numbers have drifted,
the occurrence nearest to the hunk's old line number wins. A hunk that
deletes to the end of the file, or inserts there, follows the `\ No newline
at end of file` marker for the final line break.

### SEARCH/REPLACE blocks

```
<path>
<<<<<<< SEARCH
<old lines>
=======
<new lines>
>>>>>>> REPLACE
```

The path is the nearest non-blank, non-fence line above the block (or the
previous block's path). Empty old lines create the file. Otherwise the old
lines must occur exactly once at their tier, or the block fails as
`ambiguous`.

### V4A patches

```
*** Begin Patch
*** Add File: <path>
+<line>
*** Delete File: <path>
*** Update File: <path>
*** Move to: <new path>
@@ <anchor>
 <context>
-<old>
+<new>
*** End of File
*** End Patch
```

Chunks apply in order behind a cursor that only moves forward; an anchor
pins a chunk to the first matching line at or after the cursor, and
`*** End of File` pins a chunk to the end of the file.

### JSON edits

One JSON array of edit objects, or one edit object per line (JSON Lines).
Commands: `create` (`file_text`), `str_replace` (`old_str`, `new_str`),
and `insert` (`insert_line`, `new_str`).

## Requirements

Node 22 or newer, standard library only — no dependencies to install.

## License

MIT. See `LICENSE`.
