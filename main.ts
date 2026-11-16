// Silowek Mark — harness driver for the make.fun markdown-render-speed-02
// bounty. Reads every case from /input/cases.json, renders each one alone
// with parse() from parse.js, and writes /output/html.json: a JSON array of
// the HTML strings, one per case, in the cases' order. Outside a container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// Revision 3: pre-allocate the output array (index assignment instead of
// push — the case count is known up front, so there is no reason to grow
// the array incrementally), and validate each case's markdown field so a
// malformed case fails loudly with its index instead of crashing deep
// inside parse() with no context.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as
  | { id: string; markdown: string }[]
  | { cases: { id: string; markdown: string }[] };
const cases = Array.isArray(raw) ? raw : raw.cases;

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  const md = cases[i].markdown;
  if (typeof md !== 'string') {
    throw new Error(`silowek-mark: case ${i} (${cases[i]?.id ?? 'unknown'}) has no markdown string`);
  }
  html[i] = parse(md);
  if ((i + 1) % 200 === 0) console.error(`silowek-mark: ${i + 1}/${cases.length} cases rendered`);
}
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
console.error(`silowek-mark: done, ${cases.length} cases`);
