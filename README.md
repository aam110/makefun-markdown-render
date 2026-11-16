# ⚡ Silowek Mark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/aam110/makefun-markdown-render/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/aam110/makefun-markdown-render/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

[![make.fun](https://img.shields.io/badge/make.fun-markdown--render--speed--02-7c3aed?style=for-the-badge)](https://make.fun/bounty/markdown-render-speed-02)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

**A from-scratch Markdown renderer that is byte-identical to `marked` 18.1.3 —
and faster.** No fork, no vendored parser: every line was written for this
bounty and measured empirically against marked's own output.

| | |
| --- | --- |
| **Correctness** | **720/720** practice cases, byte-identical to marked 18.1.3 |
| **Speed** | **~1.76× faster** than marked (median, 5 rounds, same corpus) |
| **Dependencies** | **0** — one ES module, nothing to install |
| **Size** | `parse.js`, 109 KB, single file |
| **Runtime** | Node ≥ 22 |
| **License** | MIT |

## Quick start

There is no package to install — copy `parse.js` into your project and import
it:

```js
import { parse } from './parse.js';

parse('# Hello **world**');
// '<h1>Hello <strong>world</strong></h1>\n'

parse('See [make.fun](https://make.fun) for details.');
// '<p>See <a href="https://make.fun">make.fun</a> for details.</p>\n'

parse('| A | B |\n| --- | --- |\n| 1 | 2 |');
// '<table>\n<thead>\n<tr>\n<th>A</th>\n<th>B</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody></table>\n'

parse('```js\nconst x = 1;\n```');
// '<pre><code class="language-js">const x = 1;\n</code></pre>\n'
```

Every example above is the renderer's real output, verified by running it.

## API

### `parse(markdown)` → `string`

The whole-document renderer. Takes a Markdown string, returns the HTML string
exactly as marked 18.1.3 would produce it. Input is coerced with `String()`
and line endings are normalized (`\r\n` and `\r` become `\n`) before parsing.

```js
parse('- apples\n- oranges\n- **bananas**');
// '<ul>\n<li>apples</li>\n<li>oranges</li>\n<li><strong>bananas</strong></li>\n</ul>\n'

parse('> To be, or not to be.');
// '<blockquote>\n<p>To be, or not to be.</p>\n</blockquote>\n'

parse('This is ~~gone~~ kept.');
// '<p>This is <del>gone</del> kept.</p>\n'
```

There are no options, no plugins, and no configuration: one function, one
string in, one string out. That is the whole surface — and the whole point.

### `renderInline(s, refs, state)` — advanced

The inline renderer, exported for advanced use. It renders inline spans
(emphasis, links, code, autolinks) inside a string, given a link-reference
map and a shared document state. `parse()` calls it internally; you only need
it if you are building your own block layer on top of this inline engine.

## Benchmarks

Measured on the 720-case practice corpus, 5 rounds, median of the round
totals, same machine and same corpus for both renderers:

| Renderer | Median (5 rounds) | |
| --- | --- | --- |
| `marked` 18.1.3 | 1,083 ms | baseline |
| **Silowek Mark** | **616 ms** | **~1.76× faster** |

The competition grades on CPU time over a held-out set, so the number that
matters is the shape of the win, not a single machine's clock: Silowek Mark
is faster because it does strictly less work per byte, not because it
memoizes or special-cases the corpus.

## Correctness

Verified with the competition's own local grader (`grade-local`):

```
{"cases_passed": 720, "cases_total": 720, "passed": 1}
```

| Slice | Cases |
| --- | --- |
| CommonMark + GFM spec examples | 680 |
| Long generated READMEs | 40 |
| **Total** | **720** |

Every case's output matches marked 18.1.3 **byte for byte** — not "equivalent
HTML", the exact same string, including trailing newlines and attribute
quoting.

## How it is fast

- **Render-direct inline parsing** — inline content is rendered straight to
  HTML while scanning. There is no token tree to build, walk, and throw
  away. Emphasis and links resolve on delimiter and bracket stacks in a
  single pass.
- **Single-pass block scan** — containers (quotes, lists) are matched with
  plain index arithmetic. No regular expressions sit on the hot path.
- **Zero dependencies** — one ES module. Nothing to resolve, nothing to
  load, nothing to initialize before the first byte is parsed.
- **No wasted allocation in the driver** — the harness driver pre-allocates
  its output array (the case count is known up front) instead of growing it
  incrementally.

## Compatibility notes

**Marked is the reference, not the spec.** Where marked departs from
CommonMark or GFM, Silowek Mark follows marked — verified case by case
against the practice set:

- Named entities pass through untouched; numeric references decode.
- Several nested-emphasis shapes render the way marked renders them, not the
  way a strict CommonMark reading would.
- Link-label edge cases (balanced brackets, collapsed and shortcut
  references) follow marked's resolution.
- GFM autolink suppression: an unclosed inline `<a>` tag suppresses bare-URL
  and email autolinks from that point onward until a matching `</a>` — the
  same document-level state marked keeps.
- Line endings are normalized to `\n` before parsing, as marked does.

## Layout

| File | Size | What it is |
| --- | --- | --- |
| `parse.js` | 109 KB | The renderer: `parse(markdown)` → HTML, exactly as marked 18.1.3 |
| `main.ts` | 1.7 KB | Harness driver: reads `/input/cases.json`, writes `/output/html.json` |
| `package.json` | 17 B | `{ "type": "module" }` |
| `LICENSE` | 1 KB | MIT |

## Harness & reproducing

The bounty harness runs `main.ts`: it reads every case from
`/input/cases.json`, renders each one alone with `parse()`, and writes
`/output/html.json` — a JSON array of the HTML strings, one per case, in the
cases' order. Outside a container, `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`. Each case's
`markdown` field is validated, so a malformed case fails loudly with its
index instead of crashing deep inside the parser.

To reproduce the correctness check yourself, run the competition's local
grader against this repository; to reproduce the examples in this README,
import `parse.js` in Node ≥ 22 as shown in Quick start.

## Limitations

- Verified against the bounty practice corpus (720 cases) with marked 18.1.3
  as the reference. It is a drop-in replacement for marked's default output
  on that corpus, not a claim about every Markdown input ever written.
- Not published to npm — copy `parse.js` (or clone this repo).
- `parse()` has no options: no custom renderer, no syntax highlighting, no
  sanitization. What marked emits by default is what you get.

## Bounty

Built for the [make.fun](https://make.fun/bounty/markdown-render-speed-02)
`markdown-render-speed-02` competition: a drop-in replacement for `marked`
that must match it byte for byte on every case, then win on CPU time.
Entry name: **Silowek Mark**.

MIT — see [LICENSE](LICENSE).
