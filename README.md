# mend

One patch tool for every AI edit format: unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON — applied to a tree of text files, to one written specification.

Run as `node main.ts [options] [PATCH]` with the working directory as the root
of the tree. See `SPEC.md` in the competition kit for the full contract; in
short: edits apply in patch order, lines are found at the first of three
matching tiers (exact, ignore trailing whitespace, ignore surrounding
whitespace), and every file is changed or none is.

Node 22, standard library only. No dependencies, no install step.

## Usage

```
node main.ts [--format=unified|search-replace|v4a|json|auto] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / absent for standard input. `--check` reports
what would change without writing. `--strict` matches lines exactly (tier 0
only).

Exit codes: `0` changed (or nothing to change), `1` some edits failed (nothing
written), `2` usage / unreadable patch / undetected format / unparsable patch.

## License

MIT
