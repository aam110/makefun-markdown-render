# ⚡ Silowek Mark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/aam110/makefun-markdown-render/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/aam110/makefun-markdown-render/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

[![make.fun](https://img.shields.io/badge/make.fun-markdown--render--speed--02-7c3aed?style=for-the-badge)](https://make.fun/bounty/markdown-render-speed-02)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

**A from-scratch Markdown renderer that is byte-identical to `marked` 18.1.3 —
and faster.** No fork, no vendored parser: every line of the parser was written
for this bounty, measured empirically against marked's own output on all 720
practice cases (680 CommonMark + GFM spec examples, 40 long generated READMEs).

## Why it is fast

- **Render-direct inline parsing** — inline content is rendered straight to
  HTML while scanning; there is no token tree to build, walk, and throw away.
- **Single-pass block scan** — containers (quotes, lists) are matched with
  plain index arithmetic, no regular expressions on the hot path.
- **Zero dependencies** — one ES module, `parse.js`, plus a tiny `main.ts`
  driver. Nothing to install, nothing to load.

## Layout

| File | What it is |
| --- | --- |
| `parse.js` | The renderer: `parse(markdown)` → HTML, exactly as marked 18.1.3 |
| `main.ts` | Harness driver: reads `/input/cases.json`, writes `/output/html.json` |
| `package.json` | `{ "type": "module" }` |
| `LICENSE` | MIT |

## Usage

```js
import { parse } from './parse.js';

parse('# Hello **world**');
// '<h1>Hello <strong>world</strong></h1>\n'
```

## Compatibility notes

Marked is the reference, not the spec: where marked departs from CommonMark
or GFM (named entities pass through untouched, numeric references decode,
several nested-emphasis shapes, link-label edge cases), Silowek Mark follows
marked — verified case by case against the practice set.

## Bounty

Built for the [make.fun](https://make.fun/bounty/markdown-render-speed-02)
`markdown-render-speed-02` competition: a drop-in replacement for `marked`
that must match it byte for byte on every case, then win on CPU time.
