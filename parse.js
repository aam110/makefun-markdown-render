// Silowek Mark — a from-scratch Markdown renderer, byte-identical to
// marked 18.1.3 with its default options (gfm on, breaks off, pedantic off,
// async off). Written for the make.fun markdown-render-speed-02 bounty.
// No part of marked is vendored or forked here: every rule below was
// re-derived from the CommonMark/GFM specs and from probing marked's
// behaviour by running it against the practice set.
//
// Design: single-pass block scan over lines (containers matched with plain
// index arithmetic), and a render-direct inline scanner: text is emitted
// while scanning, with a delimiter stack for emphasis and a bracket stack
// for links. No token tree is built.

// ---------------------------------------------------------------- helpers

const PUNCT = new Uint8Array(128);
for (const c of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT[c.charCodeAt(0)] = 1;

function isSpace(ch) { // ASCII whitespace incl. \v \f
  return ch === 32 || ch === 9 || ch === 10 || ch === 11 || ch === 12 || ch === 13;
}
function isDigit(ch) { return ch >= 48 && ch <= 57; }
function isAlpha(ch) { return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122); }
function isAlnum(ch) { return isAlpha(ch) || isDigit(ch); }
function isHex(ch) {
  return isDigit(ch) || (ch >= 65 && ch <= 70) || (ch >= 97 && ch <= 102);
}
function isPunctCode(code) {
  if (code < 128) return PUNCT[code] === 1;
  return PUNCT_RE.test(String.fromCodePoint(code));
}
// ASCII punctuation only (backslash escapes, CommonMark rule).
function isAsciiPunctCode(code) {
  return code < 128 && PUNCT[code] === 1;
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/u;
function isWSCode(code) {
  if (code < 128) return isSpace(code);
  return WS_RE.test(String.fromCodePoint(code));
}

// Column of the character at index i in line, counting tabs as advancing
// to the next multiple of 4 (columns start at 0, raw line coordinates).
function colAt(line, i) {
  let col = 0;
  for (let k = 0; k < i; k++) col = line.charCodeAt(k) === 9 ? col + 4 - (col % 4) : col + 1;
  return col;
}

// Expand tabs in `s` (a slice of a line) assuming it starts at column col0.
function expandTabs(s, col0) {
  if (s.indexOf('\t') < 0) return s;
  let out = '', col = col0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9) { const n = 4 - (col % 4); out += '    '.slice(0, n); col += n; }
    else { out += s[i]; col++; }
  }
  return out;
}

// ------------------------------------------------------- escaping/entities
//
// marked's text escaping, probed empirically:
//   &  -> entity-aware: &#...; / &#x...; decode (0, surrogates, >0x10FFFF
//        become U+FFFD); &name; passes through unchanged (any alphanumerics);
//        anything else becomes &amp;
//   < > " ' -> &lt; &gt; &quot; &#39;
// In attributes (title, alt) and hrefs, numeric references are NOT decoded:
// they pass through like named ones.

// Decode one entity reference at s[i] === '&'. Returns [text, length] or
// null. `decodeNumeric` false keeps numeric references literal.
function entityAt(s, i, decodeNumeric) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  const c = s.charCodeAt(j);
  if (c === 35) { // '#'
    j++;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const ds = j;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (hex ? isHex(d) : isDigit(d)) j++; else break;
    }
    if (j > ds && j < n && s.charCodeAt(j) === 59 && j - ds <= (hex ? 6 : 7)) {
      if (!decodeNumeric) return [s.slice(i, j + 1), j + 1 - i];
      const cp = parseInt(s.slice(ds, j), hex ? 16 : 10);
      if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return ['\uFFFD', j + 1 - i];
      return [String.fromCodePoint(cp), j + 1 - i];
    }
    return null;
  }
  if (isAlnum(c)) {
    j++;
    while (j < n && isAlnum(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 59) return [s.slice(i, j + 1), j + 1 - i];
    return null;
  }
  return null;
}

// Escape raw text for HTML text content (entity-aware, numeric decodes).
function escText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      const e = entityAt(s, i, true);
      if (e) {
        if (start < i) out += s.slice(start, i);
        const d = e[0];
        out += d === '&' ? '&amp;' : d === '<' ? '&lt;' : d === '>' ? '&gt;' : d === '"' ? '&quot;' : d === "'" ? '&#39;' : d;
        i += e[1] - 1; start = i + 1; continue;
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) { if (start < i) out += s.slice(start, i); out += rep; start = i + 1; }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// Escape for code spans and code blocks: every '&' becomes '&amp;' —
// entity references are NOT decoded here.
function escLiteral(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) { if (start < i) out += s.slice(start, i); out += rep; start = i + 1; }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// Escape for an HTML attribute value (no numeric decoding).
function escAttr(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      const e = entityAt(s, i, false);
      if (e) { if (start < i) out += s.slice(start, i); out += e[0]; i += e[1] - 1; start = i + 1; continue; }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) { if (start < i) out += s.slice(start, i); out += rep; start = i + 1; }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// Percent-encode an href the way marked does (encodeURI semantics):
// everything except A-Z a-z 0-9 and ;,/?:@&=+$-_.!~*'()# is UTF-8
// percent-encoded. Lone surrogates become U+FFFD first (encodeURI would
// throw on them; marked never throws on input text).
const HREF_SAFE = new Uint8Array(128);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;,/?:@&=+$-_.!~*\'()#%') HREF_SAFE[c.charCodeAt(0)] = 1;
const HEXD = '0123456789ABCDEF';
function hrefEncode(s) {
  let out = null; // lazily allocated
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 128 && HREF_SAFE[code]) { if (out !== null) out += s[i]; continue; }
    if (out === null) out = s.slice(0, i);
    if (code < 128) { out += '%' + HEXD[code >> 4] + HEXD[code & 15]; continue; }
    let cp = code;
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); i++; }
      else cp = 0xFFFD;
    } else if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
    if (cp < 0x800) {
      out += '%' + HEXD[(cp >> 6 | 0xC0) >> 4] + HEXD[(cp >> 6 | 0xC0) & 15]
        + '%' + HEXD[(cp & 0x3F | 0x80) >> 4] + HEXD[(cp & 0x3F | 0x80) & 15];
    } else if (cp < 0x10000) {
      out += '%' + HEXD[(cp >> 12 | 0xE0) >> 4] + HEXD[(cp >> 12 | 0xE0) & 15]
        + '%' + HEXD[((cp >> 6) & 0x3F | 0x80) >> 4] + HEXD[((cp >> 6) & 0x3F | 0x80) & 15]
        + '%' + HEXD[(cp & 0x3F | 0x80) >> 4] + HEXD[(cp & 0x3F | 0x80) & 15];
    } else {
      out += '%' + HEXD[(cp >> 18 | 0xF0) >> 4] + HEXD[(cp >> 18 | 0xF0) & 15]
        + '%' + HEXD[((cp >> 12) & 0x3F | 0x80) >> 4] + HEXD[((cp >> 12) & 0x3F | 0x80) & 15]
        + '%' + HEXD[((cp >> 6) & 0x3F | 0x80) >> 4] + HEXD[((cp >> 6) & 0x3F | 0x80) & 15]
        + '%' + HEXD[(cp & 0x3F | 0x80) >> 4] + HEXD[(cp & 0x3F | 0x80) & 15];
    }
  }
  return out === null ? s : out;
}

// Full href attribute value: percent-encode, then entity-aware escape.
function escHref(s) {
  return escAttr(hrefEncode(s));
}

// Unescape backslash escapes: \X -> X for ASCII punctuation X, else literal.
function unesc(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunctCode(s.charCodeAt(i + 1))) {
      if (start < i) out += s.slice(start, i);
      out += s[i + 1]; i++; start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// Normalize a link label for reference lookup: collapse whitespace runs
// (incl. newlines) to one space, trim, Unicode case-fold. JavaScript's
// toLowerCase does not fold ß/ẞ to "ss" (nor the ligatures), so do those
// explicitly (full case folding per Unicode CaseFolding.txt).
function normLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss').replace(/ẞ/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st')
    .replace(/µ/g, 'μ').replace(/ς/g, 'σ');
}

// ------------------------------------------------------------- inline parser
//
// Node types (arrays for speed; first element is the type tag):
//   0 text      [0, rawString]
//   1 delim     [1, ch, n, canOpen, canClose, origLen, opens, closes, dead]
//               opens/closes: lists of [use, otherNode] pairs, filled by
//               the emphasis resolver. n = remaining (unmatched) delims.
//   2 code      [2, rawContent]
//   3 html      [3, rawHtml]
//   4 br        [4]            hard break
//   5 nl        [5]            soft break (renders as \n)
//   6 link      [6, kids, href, title, isImage]
//   7 auto      [7, href, displayText, truncPos]
//               truncPos: source index of ']' where a bare URL was cut
//               short inside a bracket (-1 when not truncated).
//   8 open      [8, isImage, active, srcPos, labelStart]
//               a '[' placeholder; srcPos = index of '[', labelStart =
//               index just after '[' (or after '![').

const SPECIAL_RE = /[\\`*_~\[\]<>!\n]/g;
const DISALLOWED_HTML = new Set(['title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext']);

// Flanking for a delimiter run [start, end) in s. Returns [canOpen, canClose]
// following the CommonMark rules (with the '_' restrictions).
const WORD_CP_RE = /[\p{L}\p{N}]/u;
function isWordCharAt(s, pos) {
  if (pos < 0 || pos >= s.length) return false;
  return WORD_CP_RE.test(String.fromCodePoint(s.codePointAt(pos)));
}

function flanking(s, start, end, ch) {
  const before = start > 0 ? s.codePointAt(start - 1) : -1;
  // codePointAt(start-1) reads a surrogate pair starting there; if the char
  // before is a low surrogate, step back one more.
  let b = before;
  if (start > 1 && before >= 0xDC00 && before <= 0xDFFF) b = s.codePointAt(start - 2);
  const after = end < s.length ? s.codePointAt(end) : -1;
  const beforeWS = b < 0 || isWSCode(b);
  const afterWS = after < 0 || isWSCode(after);
  const beforePunct = b >= 0 && isPunctCode(b);
  const afterPunct = after >= 0 && isPunctCode(after);
  const leftFlanking = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const rightFlanking = !beforeWS && (!beforePunct || afterWS || afterPunct);
  let canOpen, canClose;
  if (ch === 95) { // '_'
    canOpen = leftFlanking && (!rightFlanking || beforePunct);
    canClose = rightFlanking && (!leftFlanking || afterPunct);
  } else {
    canOpen = leftFlanking;
    canClose = rightFlanking;
  }
  return [canOpen, canClose];
}

// Find a code span starting at the backtick run [start, end) in s.
// Returns [content, endIndex] (endIndex just past the closing run) or null.
function findCodeSpan(s, start, end, limit) {
  const runLen = end - start;
  const n = limit !== undefined ? limit : s.length;
  let i = end;
  while (i < n) {
    const j = s.indexOf('`', i);
    if (j < 0 || j >= n) return null;
    let k = j;
    while (k < n && s.charCodeAt(k) === 96) k++;
    if (k - j === runLen) {
      let content = s.slice(end, j);
      content = content.replace(/\n/g, ' ');
      if (content.length > 1 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      return [content, k];
    }
    i = k;
  }
  return null;
}

// Try to parse an autolink <...> or raw HTML tag starting at s[i] === '<'.
// Returns [kind, endIndex, text] where kind is 'auto' (text = inner),
// 'html' (text = the tag), or null when it is a literal '<'.
function parseAngle(s, i) {
  const n = s.length;
  // Comment, processing instruction, CDATA, declaration.
  if (s.startsWith('<!--', i)) {
    // <!--> and <!---> are complete (empty) comments on their own.
    if (s.startsWith('<!-->', i)) return ['html', i + 5, s.slice(i, i + 5)];
    if (s.startsWith('<!--->', i)) return ['html', i + 6, s.slice(i, i + 6)];
    const j = s.indexOf('-->', i + 4);
    if (j >= 0) return ['html', j + 3, s.slice(i, j + 3)];
    return null;
  }
  if (s.startsWith('<?', i)) {
    const j = s.indexOf('?>', i + 2);
    if (j >= 0) return ['html', j + 2, s.slice(i, j + 2)];
    return null;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const j = s.indexOf(']]>', i + 9);
    if (j >= 0) return ['html', j + 3, s.slice(i, j + 3)];
    return null;
  }
  if (s.startsWith('<!', i) && i + 2 < n && isAlpha(s.charCodeAt(i + 2))) {
    // Declaration: scan to '>', allowing quoted strings.
    let j = i + 2;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return ['html', j + 1, s.slice(i, j + 1)];
      if (c === 34 || c === 39) {
        const q = s.indexOf(s[j], j + 1);
        if (q < 0) return null;
        j = q + 1;
      } else j++;
    }
    return null;
  }
  // Autolink scan: the first '>' on this line (no line endings, no '<'
  // inside). A '>' always closes the autolink, even after a backslash
  // (the backslash is part of the URL, percent-encoded in the href).
  // Tags may span lines, so a newline here only rules out the autolink,
  // not the tag.
  let j = i + 1;
  let nl = false;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 10) { nl = true; break; }
    if (c === 60) { nl = true; break; }
    if (c === 62) break;
    j++;
  }
  if (!nl && j < n) {
    const inner = s.slice(i + 1, j);
    // Autolink: scheme:... or email.
    if (inner.length > 0) {
      const colon = inner.indexOf(':');
      if (colon >= 2 && colon <= 32) {
        const scheme = inner.slice(0, colon);
        if (/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) && !/[\s<>]/.test(inner.slice(colon + 1)) && inner.slice(colon + 1).length > 0) {
          return ['auto', j + 1, inner];
        }
      }
      if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(inner)) {
        return ['auto', j + 1, inner];
      }
    }
  }
  // HTML tag: <name ...>, </name ...>, with attributes (may span lines).
  const tag = parseHtmlTag(s, i);
  if (tag) return tag;
  return null;
}

// Parse an HTML open/close tag starting at s[i] === '<'. Returns
// ['html', end, text] or null.
function parseHtmlTag(s, i) {
  const n = s.length;
  let j = i + 1;
  let closing = false;
  if (j < n && s.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n || !isAlpha(s.charCodeAt(j))) return null;
  const nameStart = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 45) j++; else break;
  }
  const name = s.slice(nameStart, j).toLowerCase();
  if (closing) {
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    if (j < n && s.charCodeAt(j) === 62) return ['html', j + 1, s.slice(i, j + 1), name];
    return null;
  }
  // Attributes. Each attribute must be preceded by whitespace (except
  // that '>' or '/>' may follow the tag name directly). Whitespace after
  // a valueless attribute's name counts as the separator for the next one.
  let wsBefore = false;
  for (;;) {
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10) { j++; wsBefore = true; } else break;
    }
    if (j >= n) return null;
    const c = s.charCodeAt(j);
    if (c === 62) return ['html', j + 1, s.slice(i, j + 1), name];
    if (c === 47) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 62) return ['html', j + 2, s.slice(i, j + 2), name];
      return null;
    }
    if (!wsBefore) return null; // attribute without separating whitespace
    wsBefore = false;
    // Attribute name.
    if (!(isAlpha(c) || c === 95 || c === 58)) return null;
    j++;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isAlnum(d) || d === 95 || d === 58 || d === 45 || d === 46) j++; else break;
    }
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10) { j++; wsBefore = true; } else break;
    }
    if (j < n && s.charCodeAt(j) === 61) { // '='
      j++;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === 32 || d === 9 || d === 10) j++; else break;
      }
      if (j >= n) return null;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        const end = s.indexOf(s[j], j + 1);
        if (end < 0) return null;
        j = end + 1;
      } else {
        // Unquoted value: no space, ", ', =, <, >, `.
        let k = j;
        while (k < n) {
          const d = s.charCodeAt(k);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          k++;
        }
        if (k === j) return null;
        j = k;
      }
      wsBefore = false;
    }
  }
}

// ------------------------------------------------------- bare URL / email
//
// GFM extended autolinks as marked implements them (probed empirically):
//   - schemes http/https only (any case); www. links; email links.
//   - a bare URL's path takes any char except whitespace, '<', '>'; '(' is
//     taken only when a ')' follows it before any whitespace (else the URL
//     ends just before the '('); ')' and ']' are ordinary path chars.
//   - after the scan, trailing punctuation ? ! . , : * _ ~ is dropped, a
//     trailing ';' is dropped unless it ends an entity reference, and
//     trailing ')'s are dropped while the last one is unpaired (a ')'
//     counts as paired only when the nearest paren before it is '(').
//   - inside an active bracket, a bare URL stops at ']' (it may be repaired
//     later if no link forms there).

const TRAIL_PUNCT = new Set([63, 33, 46, 44, 58, 42, 95, 126, 39, 34]); // ? ! . , : * _ ~ ' "

// Trim the end of a bare-URL candidate [start, end) in s. Returns new end.
function trimBareUrl(s, start, end) {
  let e = end;
  for (;;) {
    if (e <= start) return e;
    const c = s.charCodeAt(e - 1);
    if (TRAIL_PUNCT.has(c)) { e--; continue; }
    if (c === 59) { // ';' — drop the whole &...; if it ends an entity ref
      let j = e - 2;
      while (j >= start && isAlnum(s.charCodeAt(j))) j--;
      if (j >= start && s.charCodeAt(j) === 38 && j + 1 < e - 1) { e = j; continue; }
      if (j >= start && s.charCodeAt(j) === 35 && j - 1 >= start && s.charCodeAt(j - 1) === 38) { e = j - 1; continue; }
      e--;
      continue;
    }
    if (c === 41) { // ')' — drop while unpaired
      // Find the nearest paren before this ')'.
      let j = e - 2;
      while (j >= start) {
        const d = s.charCodeAt(j);
        if (d === 40) break; // '(' pairs with it
        if (d === 41) { e--; j = -2; break; } // ')' before it: unpaired
        j--;
      }
      if (j === -2) continue; // dropped one, re-check
      if (j < start) { e--; continue; } // no '(' at all: unpaired
      break; // paired: keep
    }
    break;
  }
  return e;
}

// Scan a bare URL starting at s[start] (scheme or 'www.' already matched).
// inBracket: stop at ']'. Returns [end, truncated] or null if the domain
// is invalid. end is post-trim.
function scanBareUrl(s, start, inBracket, isWww) {
  const n = s.length;
  let i = start;
  // Domain: labels of [A-Za-z0-9_-]+ separated by single dots, then an
  // optional path starting with '/'. Trailing dots are trimmed later.
  let dots = 0;
  let labelLen = 0;
  let j = i;
  // First, scan the domain (up to '/', whitespace, '<', '>', or end).
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 45 || c === 95) { labelLen++; j++; continue; }
    if (c === 46) { // '.'
      if (labelLen === 0) {
        // Empty label: trailing dots (trimmed) or a middle empty label
        // (invalid). Look ahead past the dots: a label char means invalid.
        let k = j;
        while (k < n && s.charCodeAt(k) === 46) k++;
        if (k < n) {
          const nc = s.charCodeAt(k);
          if (isAlnum(nc) || nc === 45 || nc === 95) return null;
        }
        break;
      }
      dots++;
      labelLen = 0;
      j++;
      continue;
    }
    break;
  }
  if (labelLen === 0) {
    // The domain ended with a dot (or is empty): back up to the last label.
    let k = j - 1;
    while (k >= start && s.charCodeAt(k) === 46) k--;
    if (k < start) return null; // empty domain
    j = k + 1;
  }
  // Path: consume URL chars; '(' only with a later ')' before whitespace.
  let e = j;
  let truncated = -1;
  while (e < n) {
    const c = s.charCodeAt(e);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62) break;
    if (inBracket && c === 93) { truncated = e; break; }
    if (c === 40) { // '(' — needs a ')' before whitespace
      let k = e + 1;
      let ok = false;
      while (k < n) {
        const d = s.charCodeAt(k);
        if (d === 32 || d === 9 || d === 10 || d === 60 || d === 62) break;
        if (d === 41) { ok = true; break; }
        k++;
      }
      if (!ok) break;
      e++;
      continue;
    }
    e++;
  }
  const trimmed = trimBareUrl(s, start, e);
  if (trimmed <= start) return null;
  // Truncated at ']' only when the URL actually reaches it (no trailing
  // punctuation was trimmed off first).
  return [trimmed, (truncated >= 0 && trimmed === truncated) ? truncated : -1];
}

// Scan an email autolink whose '@' is at s[at]. localStart is the start of
// the local part (already found by scanning back). Returns [start, end]
// (post-trim) or null.
function scanEmail(s, at, localStart) {
  const n = s.length;
  // Domain: labels separated by single dots, at least one dot.
  let j = at + 1;
  let dots = 0;
  let labelLen = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 45 || c === 95) { labelLen++; j++; continue; }
    if (c === 46) {
      if (labelLen === 0) return null;
      dots++;
      labelLen = 0;
      j++;
      continue;
    }
    break;
  }
  if (labelLen === 0 || dots < 1) return null;
  let e = j;
  // Trailing punctuation (the domain scan already stops at '.', but a
  // trailing '_' etc. must go).
  while (e > at + 1 && TRAIL_PUNCT.has(s.charCodeAt(e - 1))) e--;
  if (e <= at + 1) return null;
  return [localStart, e];
}

const EMAIL_LOCAL = new Uint8Array(128);
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-') EMAIL_LOCAL[c.charCodeAt(0)] = 1;
const EMAIL_RE = /[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.[A-Za-z0-9_-]*[A-Za-z0-9]/g;

// Is the char at s[pos] (or start-of-string) a valid char before a bare
// www/scheme autolink? Valid: start, whitespace, '(', '*', '_', '~'.
function autolinkPreceded(s, pos) {
  if (pos <= 0) return true;
  const c = s.charCodeAt(pos - 1);
  return isSpace(c) || c === 40 || c === 42 || c === 95 || c === 126;
}

// ------------------------------------------------------------ link parsing

// Parse an inline link suffix starting at s[i] === '('. Returns
// {href, title, end} (end just past the closing ')') or null.
function parseInlineSuffix(s, i) {
  const n = s.length;
  let j = i + 1;
  // Skip whitespace (incl. newlines).
  while (j < n && isSpace(s.charCodeAt(j))) j++;
  if (j >= n) return null;
  let href = '';
  if (s.charCodeAt(j) === 60) { // '<...>'
    j++;
    const ds = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      if (c === 62) break;
      if (c === 60 || c === 10) return null;
      j++;
    }
    if (j >= n) return null;
    href = unesc(s.slice(ds, j));
    j++;
  } else {
    // Bare destination: no spaces/controls, balanced parens.
    const ds = j;
    let depth = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 40) { depth++; j++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        j++;
        continue;
      }
      if (isSpace(c) || c < 32) break;
      j++;
    }
    if (depth !== 0) return null;
    href = unesc(s.slice(ds, j));
  }
  // Skip whitespace.
  while (j < n && isSpace(s.charCodeAt(j))) j++;
  if (j >= n) return null;
  let title = null;
  if (s.charCodeAt(j) === 41) return { href, title, end: j + 1 };
  // Title: "..." or '...' or (...).
  const q = s.charCodeAt(j);
  if (q !== 34 && q !== 39 && q !== 40) return null;
  const close = q === 40 ? 41 : q;
  j++;
  const ts = j;
  let ok = false;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === close) { ok = true; break; }
    j++;
  }
  if (!ok) return null;
  title = unesc(s.slice(ts, j));
  j++;
  while (j < n && isSpace(s.charCodeAt(j))) j++;
  if (j >= n || s.charCodeAt(j) !== 41) return null;
  return { href, title, end: j + 1 };
}

// Parse a reference label starting at s[i] === '['. Returns [label, end]
// (end just past ']') or null. Brackets inside must balance.
function parseRefLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  let depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; }
    if (c === 91) { depth++; j++; continue; }
    if (c === 93) {
      if (depth === 0) {
        const label = s.slice(i + 1, j);
        if (label.length > 999) return null;
        return [label, j + 1];
      }
      depth--;
      j++;
      continue;
    }
    if (c === 10) { /* newlines allowed in labels */ }
    j++;
  }
  return null;
}

// Is the label text (source between '[' and ']') valid for a link? Its
// brackets must balance (no unmatched ']' inside).
function labelBalanced(s, start, end) {
  let depth = 0;
  for (let j = start; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end) { j++; continue; }
    if (c === 91) depth++;
    else if (c === 93) { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

// Count backtick runs in s[start, end) and find whether any code span in
// the range has a backtick in its content. Returns [toggleOn, hasBtSpan].
// marked's label scanner toggles an in-code flag on every backtick RUN
// (not matched pairs): an odd run count poisons the label.
function labelBackticks(s, start, end) {
  let runs = 0;
  let hasBtSpan = false;
  let j = start;
  while (j < end) {
    // Skip backslash escapes (an escaped backtick is not a backtick run).
    if (s.charCodeAt(j) === 92 && j + 1 < end && isAsciiPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (s.charCodeAt(j) === 96) {
      let k = j;
      while (k < end && s.charCodeAt(k) === 96) k++;
      runs++;
      // Does this run open a code span whose content holds a backtick?
      const len = k - j;
      let m = k;
      while (m < end) {
        const b = s.indexOf('`', m);
        if (b < 0 || b >= end) break;
        let e2 = b;
        while (e2 < end && s.charCodeAt(e2) === 96) e2++;
        if (e2 - b === len) {
          if (s.slice(k, b).indexOf('`') >= 0) hasBtSpan = true;
          break;
        }
        m = e2;
      }
      j = k;
    } else j++;
  }
  // Poisoned iff an odd number of backtick runs AND the label does not end
  // with a backtick run (a label ending right at a code span is not poisoned).
  const endsWithBt = end > start && s.charCodeAt(end - 1) === 96;
  return [(runs % 2) === 1 && !endsWithBt, hasBtSpan];
}

// Is there a complete (...) group starting at s[i] === '('? Scans with
// paren depth (backslash escapes respected). Used for the poisoned-label
// emphasis-death rule.
function hasCompleteParen(s, i) {
  const n = s.length;
  let depth = 0;
  for (let j = i; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j++; continue; }
    if (c === 40) depth++;
    else if (c === 41) { depth--; if (depth === 0) return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------
// Node types (arrays, index 0 is the tag):
//   0 [0, text]                        text (escape on render)
//   1 [1, ch, n, canOpen, canClose, origN, openUses, closeUses, dead]
//                                      emphasis delimiter run
//   2 [2, content]                     code span (escLiteral on render)
//   3 [3, rawHtml]                     raw HTML tag
//   4 [4]                              hard break <br>
//   5 [5]                              soft break (newline)
//   6 [6, kids, href, title, isImg]    link or image
//   7 [7, href, display, ustart, truncPos, fullEnd]
//                                      autolink (bare URL / email / <...>)
//   8 [8, isImg, active, srcPos, labelStart]
//                                      open bracket (transient; never rendered)

const URL_START_RE = /www\.|https?:\/\/|mailto:|xmpp:/gi;

// Scan a mailto:/xmpp: autolink. `at` is the position after the scheme,
// `emailEnd` the end of the pre-scanned email span starting at `at`,
// `schemeStart` the position of the scheme itself. Returns [end, trunc]
// (trunc = position of a ']' the URL was cut at, or -1) or null.
function scanSchemeUrl(s, at, emailEnd, schemeStart, inBracket, isXmpp) {
  const n = s.length;
  let e = emailEnd;
  let trunc = -1;
  if (isXmpp && e < n && s.charCodeAt(e) === 47) {
    let p = e + 1;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 47) break;
      if (c === 93 && inBracket) { trunc = p; break; }
      if (c === 40) {
        // '(' is consumed only if a ')' follows before any whitespace.
        let q = p + 1, ok = false;
        while (q < n) {
          const qc = s.charCodeAt(q);
          if (qc === 41) { ok = true; break; }
          if (qc === 32 || qc === 9 || qc === 10 || qc === 60 || qc === 62) break;
          q++;
        }
        if (!ok) break;
      }
      p++;
    }
    if (p > e + 1) e = p;
  }
  const trimmed = trimBareUrl(s, schemeStart, e);
  if (trimmed <= schemeStart) return null;
  return [trimmed, (trunc >= 0 && trimmed === trunc) ? trunc : -1];
}

function renderInline(s, refs, state) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  const n = s.length;
  const emails = [];
  // Document-level GFM autolink suppression: an unclosed INLINE <a> tag
  // (in a paragraph, heading, or table cell — not an HTML block) suppresses
  // all bare-URL and email autolinks from that point onward (same
  // paragraph and all later blocks) until an inline </a> is seen. Angle
  // autolinks and markdown links are unaffected. `state` persists across
  // blocks within a doc. The trigger is RETROACTIVE within a paragraph:
  // if the paragraph contains an unclosed <a>, ALL autolinks in that
  // paragraph are suppressed, even those before the tag.
  if (!state) state = { suppressAutolinks: false };
  let suppressed = state.suppressAutolinks;
  if (!suppressed && s.indexOf('<') >= 0) {
    // Pre-scan for the trigger: an unclosed <a> tag. A non-self-closing
    // <a> (or <a href="...">) triggers on its own. A self-closing <a/>
    // triggers only together with a multi-line tag in the same paragraph
    // ('<a/><b2/>' alone does not suppress; '<a /><b2\ndata="foo" >' does).
    // Only VALID HTML tags count (validated by parseAngle); an invalid
    // tag like '<a href="\"">' is literal text, not a tag. Code spans
    // are skipped (a '<a>' inside backticks is not a tag).
    let aDepth = 0, hasSelfClosingA = false, hasMultiline = false;
    let si = 0;
    const sn = s.length;
    while (si < sn) {
      const lt = s.indexOf('<', si);
      const bt = s.indexOf('`', si);
      if (bt >= 0 && (lt < 0 || bt < lt)) {
        // Skip a code span (find its closing run).
        let k = bt;
        while (k < sn && s.charCodeAt(k) === 96) k++;
        const cs = findCodeSpan(s, bt, k);
        si = cs ? cs[1] : k;
        continue;
      }
      if (lt < 0) break;
      const a = parseAngle(s, lt);
      if (!a) { si = lt + 1; continue; }
      const tagEnd = a[1];
      const tagText = s.slice(lt, tagEnd);
      if (tagText.indexOf('\n') >= 0) hasMultiline = true;
      // parseAngle kind: 'html' for tags, 'autolink' for <http://...>.
      // Only tags count.
      if (a[0] === 'html') {
        if (/^<\/\s*a[\s>]/.test(tagText)) { if (aDepth > 0) aDepth--; }
        else if (/^<\s*a[\s>/]/.test(tagText)) {
          if (/\/\s*>$/.test(tagText)) hasSelfClosingA = true;
          else aDepth++;
        }
      }
      si = tagEnd;
    }
    if (aDepth > 0 || (hasSelfClosingA && hasMultiline)) suppressed = true;
  }
  if (s.indexOf('@') >= 0) {
    EMAIL_RE.lastIndex = 0;
    let m;
    while ((m = EMAIL_RE.exec(s)) !== null) emails.push([m.index, m.index + m[0].length]);
  }
  let ep = 0;
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) nodes.push([0, s.slice(textStart, end)]);
    textStart = end;
  };

  // Form a link/image from bracket `b` (entry at brackets[bi]) using the
  // parsed suffix `link` ({href, title, end}). Returns the new cursor.
  function formLink(b, bi, link) {
    const bIdx = nodes.indexOf(b);
    const kids = nodes.splice(bIdx + 1);
    nodes.splice(bIdx, 1);
    for (const k of kids) if (k[0] === 7 && k[6] !== 1) { k[0] = 0; k[1] = k[2]; k.length = 2; }
    nodes.push([6, kids, link.href, link.title, b[1]]);
    brackets.splice(bi);
    // A link deactivates earlier LINK brackets only (image brackets stay
    // active: an image may contain a link in its label). An image
    // deactivates nothing.
    if (!b[1]) for (const ob of brackets) if (!ob[1]) ob[2] = false;
    return link.end;
  }

  // Kill every emphasis delimiter among the label's top-level nodes.
  function killDelimsInLabel(b) {
    const bIdx = nodes.indexOf(b);
    for (let k = bIdx + 1; k < nodes.length; k++) if (nodes[k][0] === 1) nodes[k][8] = true;
  }

  while (i < n) {
    while (ep < emails.length && emails[ep][0] < i) ep++;
    // Email span starting exactly here (may start at a '_' delimiter char).
    // Suppressed after an unclosed multi-line <a> tag (document-level).
    if (ep < emails.length && emails[ep][0] === i) {
      if (suppressed) { ep++; }
      else {
        flushText(i);
        const es = emails[ep][0], ee = emails[ep][1]; ep++;
        nodes.push([7, 'mailto:' + s.slice(es, ee), s.slice(es, ee), -1, -1, -1, 0]);
        i = ee; textStart = i;
        continue;
      }
    }
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    let j = m ? m.index : n;
    if (ep < emails.length && emails[ep][0] < j) j = emails[ep][0];
    // Bare URL starting inside the text run [i, j). Suppressed after an
    // unclosed multi-line <a> tag (document-level).
    URL_START_RE.lastIndex = i;
    let um = suppressed ? null : URL_START_RE.exec(s);
    let urlHandled = false;
    while (um && um.index < j) {
      const ustart = um.index;
      const tok = um[0];
      const low = tok.toLowerCase();
      const isScheme = low === 'mailto:' || low === 'xmpp:';
      const isWww = low === 'www.';
      if (!isScheme && !isWww && tok[0] !== 'h' && tok[0] !== 'H') { um = URL_START_RE.exec(s); continue; }
      if (low === 'www.' && tok !== 'www.') { um = URL_START_RE.exec(s); continue; } // WWW. not lowercase
      if (isWww && !autolinkPreceded(s, ustart)) { um = URL_START_RE.exec(s); continue; }
      let inBracket = false;
      for (let bq = 0; bq < brackets.length; bq++) if (brackets[bq][2]) { inBracket = true; break; }
      let scanned = null;
      if (isScheme) {
        // The scheme name must not be part of a longer name (xmailto:).
        const pc = ustart > 0 ? s.charCodeAt(ustart - 1) : -1;
        if (pc >= 0 && (isAlnum(pc) || pc === 43 || pc === 45 || pc === 46)) { um = URL_START_RE.exec(s); continue; }
        // Find the pre-scanned email span starting right after the scheme.
        let emailEnd = -1;
        for (let ek = ep; ek < emails.length && emails[ek][0] <= ustart + tok.length; ek++) {
          if (emails[ek][0] === ustart + tok.length) { emailEnd = emails[ek][1]; break; }
        }
        if (emailEnd < 0) { um = URL_START_RE.exec(s); continue; }
        scanned = scanSchemeUrl(s, ustart + tok.length, emailEnd, ustart, inBracket, low === 'xmpp:');
      } else {
        scanned = scanBareUrl(s, ustart + tok.length, inBracket, isWww);
      }
      if (!scanned) { um = URL_START_RE.exec(s); continue; }
      const [uend, trunc] = scanned;
      flushText(ustart);
      const dispEnd = trunc >= 0 ? trunc : uend;
      const disp = s.slice(ustart, dispEnd);
      nodes.push([7, (isWww ? 'http://' : '') + disp, disp, ustart, trunc, trunc >= 0 ? uend : -1, 0]);
      i = dispEnd; textStart = i;
      urlHandled = true;
      break;
    }
    if (urlHandled) continue;
    if (ep < emails.length && emails[ep][0] === j) {
      // The text run ends exactly at an email start; let the next
      // iteration emit the email link.
      flushText(j);
      i = j; textStart = i;
      continue;
    }
    if (j >= n) { flushText(n); i = n; break; }
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      const nc = j + 1 < n ? s.charCodeAt(j + 1) : -1;
      if (nc === 10) { // hard break: strip leading spaces/tabs of next line
        flushText(j);
        nodes.push([4]);
        let k = j + 2;
        while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
        i = k; textStart = i;
      }
      else if (nc >= 0 && isAsciiPunctCode(nc)) {
        flushText(j);
        nodes.push([0, s[j + 1]]);
        i = j + 2; textStart = i;
      } else i = j + 1; // literal backslash, stays in the text run
      continue;
    }
    if (c === 96) { // backtick
      let k = j;
      while (k < n && s.charCodeAt(k) === 96) k++;
      // A code span inside an active bracket must not swallow the ']'
      // that closes the bracket IF the label is not poisoned (the link
      // will form; the backticks are literal in the link text). If the
      // label IS poisoned, the link cannot form, so the span may span
      // the ']' (e.g. cm-525 '[foo`](/uri)`' — but note cm-525's label
      // is NOT poisoned; a single 1-backtick run at the very end of the
      // label also lets the span through, while a 2-backtick run there
      // does not).
      let limit;
      for (let bq = brackets.length - 1; bq >= 0; bq--) {
        const b = brackets[bq];
        if (!b[2]) continue;
        const closeIdx = s.indexOf(']', k);
        if (closeIdx >= 0) {
          const [toggleOn] = labelBackticks(s, b[4], closeIdx);
          let singleOneAtEnd = false;
          if (!toggleOn) {
            // Count runs; check for exactly one run of length 1 ending
            // at the ']' (skipping backslash escapes).
            let runs = 0, lastLen = 0, lastEnd = -1;
            let m = b[4];
            while (m < closeIdx) {
              if (s.charCodeAt(m) === 92 && m + 1 < closeIdx && isAsciiPunctCode(s.charCodeAt(m + 1))) { m += 2; continue; }
              if (s.charCodeAt(m) === 96) {
                let e = m;
                while (e < closeIdx && s.charCodeAt(e) === 96) e++;
                runs++;
                lastLen = e - m;
                lastEnd = e;
                m = e;
              } else m++;
            }
            singleOneAtEnd = (runs === 1 && lastLen === 1 && lastEnd === closeIdx);
          }
          if (!toggleOn && !singleOneAtEnd) limit = closeIdx;
        }
        break;
      }
      const cs = findCodeSpan(s, j, k, limit);
      if (cs) { flushText(j); nodes.push([2, cs[0], k - j]); i = cs[1]; textStart = i; }
      else i = k; // unmatched run is literal text
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      let k = j;
      while (k < n && s.charCodeAt(k) === c) k++;
      const len = k - j;
      if (c === 126 && len >= 3) { i = k; continue; } // ~~~+ never pairs
      const [canOpen, canClose] = flanking(s, j, k, c);
      flushText(j);
      const d = [1, c, len, canOpen, canClose, len, [], [], false, j, k, 0, null];
      nodes.push(d);
      delims.push(d);
      i = k; textStart = i;
      continue;
    }
    if (c === 91) { // '['
      flushText(j);
      const b = [8, false, true, j, j + 1];
      nodes.push(b);
      brackets.push(b);
      i = j + 1; textStart = i;
      continue;
    }
    if (c === 33) { // '!'
      if (j + 1 < n && s.charCodeAt(j + 1) === 91) {
        flushText(j);
        const b = [8, true, true, j, j + 2];
        nodes.push(b);
        brackets.push(b);
        i = j + 2; textStart = i;
      } else i = j + 1;
      continue;
    }
    if (c === 60) { // '<'
      const a = parseAngle(s, j);
      if (a) {
        flushText(j);
        if (a[0] === 'auto') {
          const inner = a[2];
          const isEmail = !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(inner);
          nodes.push([7, isEmail ? 'mailto:' + inner : inner, inner, -1, -1, -1, 1]);
        } else {
          nodes.push([3, a[2]]);
          // Multi-line <a> suppression: an opening <a> tag whose source
          // contains a newline AFTER the first attribute (a newline
          // between the tag name and the first attribute does not count)
          // suppresses GFM autolinks until an inline </a> is seen.
          const tagText = a[2];
          if (/^<\/\s*a\s*>/i.test(tagText)) suppressed = false;
          else if (/^<\s*a[\s>]/.test(tagText) || /^<\s*a$/.test(tagText)) {
            const nlIdx = tagText.indexOf('\n');
            if (nlIdx >= 0) {
              // Is there an attribute before the newline? (a '=' or a
              // whitespace-separated token after the tag name).
              const before = tagText.slice(0, nlIdx);
              if (/^<\s*a\s+\S/.test(before)) suppressed = true;
            }
          }
        }
        i = a[1]; textStart = i;
      } else i = j + 1;
      continue;
    }
    if (c === 10) { // newline: hard break iff >= 2 trailing spaces
      let t = j;
      while (t > textStart && s.charCodeAt(t - 1) === 32) t--;
      const hard = j - t >= 2;
      flushText(hard ? t : j);
      nodes.push(hard ? [4] : [5]);
      i = j + 1;
      // After a hard break, leading spaces/tabs on the next line are gone.
      if (hard) while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
      textStart = i;
      continue;
    }
    if (c === 93) { // ']' — try to form a link/image
      flushText(j);
      let linkEnd = -1;
      for (let bi = brackets.length - 1; bi >= 0; bi--) {
        const b = brackets[bi];
        if (!b[2]) continue;
        if (!labelBalanced(s, b[4], j)) continue;
        const label = s.slice(b[4], j);
        const after = j + 1;
        const [toggleOn, hasBtSpan] = labelBackticks(s, b[4], j);
        let link = null;
        if (after < n && s.charCodeAt(after) === 40) { // '(' inline
          if (toggleOn && hasBtSpan && hasCompleteParen(s, after)) killDelimsInLabel(b);
          if (!toggleOn) link = parseInlineSuffix(s, after);
          if (link) { linkEnd = formLink(b, bi, link); break; }
          // Inline failed: fall back to the shortcut reference.
          if (!toggleOn) {
            const ref = refs.get(normLabel(label));
            if (ref) link = { href: ref.href, title: ref.title, end: after };
          }
          if (link) linkEnd = formLink(b, bi, link);
          break;
        }
        if (after < n && s.charCodeAt(after) === 91) { // '[' reference
          const rl = parseRefLabel(s, after);
          if (rl && !toggleOn) {
            const key = normLabel(rl[0] === '' ? label : rl[0]);
            const ref = refs.get(key);
            if (ref) link = { href: ref.href, title: ref.title, end: rl[1] };
          }
          if (link) linkEnd = formLink(b, bi, link);
          break;
        }
        // Shortcut reference.
        if (!toggleOn) {
          const ref = refs.get(normLabel(label));
          if (ref) link = { href: ref.href, title: ref.title, end: after };
        }
        if (link) linkEnd = formLink(b, bi, link);
        break;
      }
      if (linkEnd >= 0) { i = linkEnd; textStart = i; continue; }
      // No link formed: repair a truncated bare URL ending at this ']'.
      const last = nodes[nodes.length - 1];
      if (last && last[0] === 7 && last[4] === j) {
        const fullDisp = s.slice(last[3], last[5]);
        last[1] = fullDisp.startsWith('www.') ? 'http://' + fullDisp : fullDisp;
        last[2] = fullDisp;
        last[4] = -1;
        i = last[5]; textStart = i;
        continue;
      }
      i = j + 1; // literal ']'
      continue;
    }
    i = j + 1; // unreachable for known specials; stay safe
  }
  flushText(n);
  // Quirk: emphasis between a link whose label contains backticks and
  // the next code span (in the same paragraph) is suppressed. E.g.
  // '[a ``b`](v)\n_c_ `x` d' leaves '_c_' literal, but '_d_' after the
  // code span still forms em. Only applies when a code span actually
  // follows the link; without one, nothing is suppressed. The label
  // must contain LITERAL backticks (text nodes); a backtick inside a
  // code span in the label does not trigger it.
  const labelHasLiteralBt = (kids) => {
    for (const kd of kids) {
      if (kd[0] === 0 && kd[1].indexOf('`') >= 0) return true;
      if (kd[0] === 6 && labelHasLiteralBt(kd[1])) return true;
    }
    return false;
  };
  for (let ni = 0; ni < nodes.length; ni++) {
    const nd = nodes[ni];
    if (nd[0] !== 6 || nd[1].length === 0) continue;
    if (!labelHasLiteralBt(nd[1])) continue;
    let codeIdx = -1, firstCodeIdx = -1;
    const hasCodeSpan = (kids) => {
      for (const kd of kids) {
        if (kd[0] === 2) return (kd[2] || 1) >= 2 ? 2 : 1;
        if (kd[0] === 6) { const r = hasCodeSpan(kd[1]); if (r) return r; }
      }
      return 0;
    };
    for (let mi = ni + 1; mi < nodes.length; mi++) {
      const md = nodes[mi];
      let run = 0;
      if (md[0] === 2) run = md[2] || 1;
      else if (md[0] === 6) run = hasCodeSpan(md[1]);
      if (run > 0) {
        if (firstCodeIdx < 0) firstCodeIdx = mi;
        if (run >= 2) { codeIdx = mi; break; }
      }
    }
    if (codeIdx < 0) codeIdx = firstCodeIdx;
    if (codeIdx < 0) continue;
    for (let mi = ni + 1; mi < codeIdx; mi++) {
      const md = nodes[mi];
      if (md[0] === 1) { md[3] = false; md[4] = false; md[8] = true; }
    }
  }
  // Scope delimiters to their innermost enclosing link/image: emphasis
  // cannot match across a link boundary (the link's text is parsed for
  // emphasis on its own).
  (function assignScopes(kids, scope) {
    for (const nd of kids) {
      if (nd[0] === 1) nd[12] = scope;
      else if (nd[0] === 6) assignScopes(nd[1], nd);
    }
  })(nodes, null);
  resolveDelims(delims, s);
  // Downgrade bare email autolinks followed by a literal '_' or '-':
  // 'a@b.com_' and 'a@b.com-' do not link, but '__a@b.com__' DOES link
  // (the '_' forms emphasis, so it is consumed, not literal). Checked
  // after emphasis resolution: if the next node is an unpaired '_'
  // delimiter or text starting with '_'/'-', the email is plain text.
  for (let ni = 0; ni < nodes.length - 1; ni++) {
    const nd = nodes[ni];
    if (nd[0] !== 7 || nd[6] !== 0 || !nd[1].startsWith('mailto:')) continue;
    const nx = nodes[ni + 1];
    if (nx[0] === 1 && nx[1] === 95 && nx[6].length === 0 && nx[7].length === 0) { nd[0] = 0; nd[1] = nd[2]; }
    else if (nx[0] === 0 && (nx[1].charCodeAt(0) === 95 || nx[1].charCodeAt(0) === 45)) { nd[0] = 0; nd[1] = nd[2]; }
  }
  state.suppressAutolinks = suppressed;
  return renderNodes(nodes);
}

export { renderInline };

// ---------------------------------------------------------------------------
// Emphasis resolution (CommonMark delimiter-stack algorithm + marked quirks)
// ---------------------------------------------------------------------------

// Blocking rule (marked quirk, fitted against 13 probe cases): is opener
// `oi` blocked from matching closer `ci` with `use` delimiters?
// Applies to '*' and '_' only.
function isBlocked(delims, pairs, oi, ci, use, s) {
  const o = delims[oi], c = delims[ci];
  const between = new Map();
  for (const pr of pairs) {
    // Only same-char pairs can block (a '*' pair never blocks '_' and
    // vice versa).
    if (delims[pr[0]][1] !== o[1]) continue;
    if (pr[0] > oi && pr[1] < ci) {
      const k = pr[0] + ',' + pr[1];
      let e = between.get(k);
      if (!e) { e = { oi: pr[0], ci: pr[1], totalUse: 0 }; between.set(k, e); }
      e.totalUse += pr[2];
    }
  }
  if (between.size === 0) return false; // (i) need >= 1 pair between
  const arr = [...between.values()];
  const top = arr.filter(e => !arr.some(f => f !== e && f.oi < e.oi && e.ci < f.ci));
  if (top.length === 0) return false;
  let P = top[0];
  for (const e of top) if (e.oi < P.oi) P = e;
  const pOpener = delims[P.oi], pCloser = delims[P.ci];
  if (!isWordCharAt(s, pCloser[10])) return false; // (ii) word char after P's closer
  if (top.length > 1) {
    for (const e of top) if (delims[e.oi][5] !== pOpener[5]) return false; // (v)
  }
  if (!(pOpener[3] && !pOpener[4])) return false; // (vi) P's opener is a pure opener
  // (vii) P is a strong pair, or C sits right after the word following P's
  // closer (only word chars between P's closer end and C's start).
  if (P.totalUse !== 2) {
    let adj = true;
    for (let p = pCloser[10]; p < c[9]; p++) {
      if (!isWordCharAt(s, p)) { adj = false; break; }
    }
    if (!adj) return false;
  }
  // (iv) mod-3 conditions. effectiveO = total current length of this opener
  // plus all earlier unmatched same-char openers.
  let eff = 0;
  for (let k = 0; k <= oi; k++) {
    const d = delims[k];
    if (d[1] === o[1] && !d[8] && d[3] && d[2] > 0) eff += d[2];
  }
  if ((o[2] + pOpener[5]) % 3 === 0 && (c[2] <= 2 || eff % 3 === 0)) return true; // (iv-a)
  if ((use + P.totalUse) % 3 === 0 && eff % 3 === 0) return true; // (iv-b)
  // (iv-c) does not apply once the opener matched a different closer.
  // It requires the opener to have length >= 2 ('*changes *else*returns**'
  // has a 1-length opener, so its em forms; '***a *b*c** d*' has a
  // 3-length opener, so its inner '**' stays literal).
  if (c[2] <= 2 && o[2] >= 2 && (c[2] + P.totalUse) % 3 === 0) {
    let otherUse = false;
    for (const u of o[6]) if (u[1] !== c) { otherUse = true; break; }
    if (!otherUse) return true;
  }
  return false;
}

function resolveDelims(delims, s) {
  const pairs = []; // [openerIdx, closerIdx, use]
  // Fixpoint: a closer blocked in one pass may match in a later pass, after
  // another closer matched the same opener (which exempts it from blocking).
  let changed = true;
  while (changed) {
    changed = false;
    for (let ci = 0; ci < delims.length; ci++) {
      const c = delims[ci];
      if (c[8] || !c[4] || c[2] === 0) continue;
      const ch = c[1];
      for (let oi = ci - 1; oi >= 0;) {
        const o = delims[oi];
        if (c[2] === 0) break;
        if (o[8] || o[1] !== ch || !o[3] || o[2] === 0) { oi--; continue; }
        if (o[12] !== c[12]) { oi--; continue; } // different link scopes
        let crossed = false;
        for (let p = 0; p < pairs.length; p++) {
          const pr = pairs[p];
          if (pr[0] < oi && oi < pr[1] && pr[1] < ci) { crossed = true; break; }
          // A closer cannot match an opener strictly inside a pair it
          // already closed itself.
          if (pr[1] === ci && pr[0] < oi) { crossed = true; break; }
        }
        if (crossed) { oi--; continue; }
        if (ch === 126 && o[2] !== c[2]) { oi--; continue; } // '~': same-length only
        const eitherBoth = (o[3] && o[4]) || (c[3] && c[4]);
        if (eitherBoth) {
          const sum = o[2] + c[2];
          if (sum % 3 === 0 && !(o[2] % 3 === 0 && c[2] % 3 === 0)) { oi--; continue; }
        }
        let use = (o[2] >= 2 && c[2] >= 2) ? 2 : 1;
        if (ch !== 126 && isBlocked(delims, pairs, oi, ci, use, s)) {
          if (use === 2) {
            use = 1;
            if (isBlocked(delims, pairs, oi, ci, use, s)) { oi--; continue; }
          } else { oi--; continue; }
        }
        o[2] -= use; c[2] -= use;
        o[6].push([use, c]);
        c[7].push([use, o, 0]);
        pairs.push([oi, ci, use]);
        changed = true;
        // Retry the SAME opener: both sides may still have delimiters left.
      }
    }
  }
  // Leftover-inside rule: for a pair (O, C) with a same-char pair P strictly
  // between them whose closer is followed by a word character, leftovers
  // render INSIDE when (use != P.totalUse) or O has leftovers or an
  // unmatched same-char opener run sits between O and C. Cap: all leftovers
  // when P is strong, else at most 2.
  const pairMap = new Map();
  for (const pr of pairs) {
    const k = pr[0] + ',' + pr[1];
    if (!pairMap.has(k)) pairMap.set(k, pr);
  }
  for (const pr of pairMap.values()) {
    const oi = pr[0], ci = pr[1], use = pr[2];
    const o = delims[oi], c = delims[ci];
    if (c[1] === 126) continue;
    if (o[2] === 0 && c[2] === 0) continue;
    const between = [];
    for (const q of pairs) {
      if (q[0] > oi && q[1] < ci && delims[q[0]][1] === c[1]) between.push(q);
    }
    if (between.length === 0) continue;
    const seen = new Set();
    const uniq = [];
    for (const q of between) {
      const k = q[0] + ',' + q[1];
      if (!seen.has(k)) { seen.add(k); uniq.push(q); }
    }
    const top = uniq.filter(e => !uniq.some(f => f !== e && f[0] < e[0] && e[1] < f[1]));
    if (top.length === 0) continue;
    let P = top[0];
    for (const e of top) if (e[0] < P[0]) P = e;
    if (!isWordCharAt(s, delims[P[1]][10])) continue;
    let pTotal = 0;
    for (const q of pairs) if (q[0] === P[0] && q[1] === P[1]) pTotal += q[2];
    let cond = (use !== pTotal) || (o[2] > 0);
    if (!cond) {
      for (let k = oi + 1; k < ci; k++) {
        const d = delims[k];
        if (d[1] === c[1] && d[3] && !d[8] && d[2] > 0 && d[6].length === 0 && d[7].length === 0) { cond = true; break; }
      }
    }
    if (!cond) continue;
    const cap = pTotal === 2 ? Infinity : 2;
    if (c[2] > 0) {
      const n = Math.min(cap, c[2]);
      for (const cu of c[7]) {
        if (cu[1] === o) { if (n > cu[2]) cu[2] = n; break; }
      }
    }
    if (o[2] > 0) {
      const n = Math.min(cap, o[2]);
      if (n > o[11]) o[11] = n;
    }
  }
  // Open tags at one node: farthest closer first (outermost), same closer
  // then use ascending (em outside strong).
  for (const d of delims) {
    if (d[6].length > 1) d[6].sort((a, b) => b[1][9] - a[1][9] || a[0] - b[0]);
  }
}

function plainText(kids) {
  let out = '';
  for (const nd of kids) {
    const t = nd[0];
    if (t === 0) out += nd[1];
    else if (t === 2) out += nd[1];
    else if (t === 1) {
      const ch = nd[1] === 126 ? '~' : nd[1] === 95 ? '_' : '*';
      if (nd[2] > 0) out += ch.repeat(nd[2]);
    }
    else if (t === 4 || t === 5) out += '\n';
    else if (t === 3) out += nd[1]; // raw HTML tag text is part of alt text
    else if (t === 6) out += plainText(nd[1]);
    else if (t === 7) out += nd[2];
    else if (t === 8) out += nd[1] ? '![' : '[';
  }
  return out;
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    const t = nd[0];
    if (t === 0) out += escText(nd[1]);
    else if (t === 2) out += '<code>' + escLiteral(nd[1]) + '</code>';
    else if (t === 3) out += nd[1];
    else if (t === 4) out += '<br>';
    else if (t === 5) out += '\n';
    else if (t === 7) out += '<a href="' + escHref(nd[1]) + '">' + escText(nd[2]) + '</a>';
    else if (t === 6) {
      if (nd[4]) {
        out += '<img src="' + escHref(nd[2]) + '" alt="' + escAttr(plainText(nd[1])) + '"';
        if (nd[3] !== null) out += ' title="' + escAttr(nd[3]) + '"';
        out += '>';
      } else {
        out += '<a href="' + escHref(nd[2]) + '"';
        if (nd[3] !== null) out += ' title="' + escAttr(nd[3]) + '"';
        out += '>' + renderNodes(nd[1]) + '</a>';
      }
    } else if (t === 1) {
      const ch = nd[1] === 126 ? '~' : nd[1] === 95 ? '_' : '*';
      let inside = 0;
      for (const cu of nd[7]) {
        if (cu[2] > 0) { out += ch.repeat(cu[2]); inside += cu[2]; }
        const tag = nd[1] === 126 ? 'del' : cu[0] === 2 ? 'strong' : 'em';
        out += '</' + tag + '>';
      }
      const rest = nd[2] - inside - (nd[11] || 0);
      if (rest > 0) out += ch.repeat(rest);
      for (const ou of nd[6]) {
        const tag = nd[1] === 126 ? 'del' : ou[0] === 2 ? 'strong' : 'em';
        out += '<' + tag + '>';
      }
      if (nd[11] > 0) out += ch.repeat(nd[11]);
    } else if (t === 8) out += nd[1] ? '![' : '[';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------
// Block nodes (arrays, index 0 is the tag):
//   ['doc', children]
//   ['para', lines]            lines: content strings (tabs expanded)
//   ['head', level, text]      text: inline source
//   ['code', info, lines, fenced]
//   ['html', lines]            raw lines (tabs NOT expanded)
//   ['quote', children]
//   ['list', ordered, start, delim, tight, children]
//   ['item', children, task, indent]  task: 0 none, 1 unchecked, 2 checked
//   ['hr']
//   ['table', headerCells, aligns, rows]

// Skip up to `target` columns of indent starting at index i (column col).
// Returns [nextIndex, contentCol, spaces]: spaces is the number of literal
// spaces to prepend to the content (leftover of a partially consumed tab).
function skipIndent(line, i, col, target) {
  let remaining = target;
  let spaces = 0;
  while (remaining > 0 && i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { i++; col++; remaining--; }
    else if (c === 9) {
      const n = 4 - (col % 4);
      if (n <= remaining) { i++; col += n; remaining -= n; }
      else { spaces = n - remaining; i++; col += n; remaining = 0; }
    } else break;
  }
  return [i, col - spaces, spaces];
}

// Measure leading whitespace (columns) starting at index i (column col).
// Returns [indentCols, nextIndex, nextCol].
function measureIndent(line, i, col) {
  let indent = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { i++; col++; indent++; }
    else if (c === 9) { const n = 4 - (col % 4); i++; col += n; indent += n; }
    else break;
  }
  return [indent, i, col];
}

function isBlankLine(line, i) {
  for (let k = i; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ATX heading: returns [level, textStart, textEnd] or null. `i` is the
// first non-space index, `col` its column (indent already <= 3).
function scanAtx(line, i) {
  const n = line.length;
  let level = 0;
  while (i + level < n && line.charCodeAt(i + level) === 35) level++;
  if (level === 0 || level > 6) return null;
  const after = i + level;
  if (after < n) {
    const c = line.charCodeAt(after);
    if (c !== 32 && c !== 9) return null;
  }
  let s = after;
  while (s < n && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = n;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  // Strip a closing sequence of #'s preceded by a space. The closing #'s
  // may be the entire heading text (### ### -> empty <h3>).
  let h = e;
  while (h > s && line.charCodeAt(h - 1) === 35) h--;
  if (h < e && h > i + level && (line.charCodeAt(h - 1) === 32 || line.charCodeAt(h - 1) === 9)) {
    e = h - 1;
    while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  }
  return [level, s, e];
}

// Fenced code open: returns [char, length, infoStart, infoEnd] or null.
function scanFence(line, i) {
  const n = line.length;
  const ch = line.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (i + len < n && line.charCodeAt(i + len) === ch) len++;
  if (len < 3) return null;
  let s = i + len;
  while (s < n && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = n;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (ch === 96 && line.slice(s, e).indexOf('`') >= 0) return null;
  return [ch, len, s, e];
}

// Thematic break: returns true if the line (from i) is a thematic break.
function scanThematicBreak(line, i) {
  const n = line.length;
  const ch = line.charCodeAt(i);
  if (ch !== 45 && ch !== 42 && ch !== 95) return false;
  let count = 0;
  for (let k = i; k < n; k++) {
    const c = line.charCodeAt(k);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

// Setext underline: returns 1 (===) or 2 (---) or 0.
function scanSetext(line, i) {
  const n = line.length;
  const ch = line.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return 0;
  let k = i;
  while (k < n && line.charCodeAt(k) === ch) k++;
  for (; k < n; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return 0;
  }
  return ch === 61 ? 1 : 2;
}

// List marker: returns [markerLen, isOrdered, startNum, delimChar, contentIdx,
// contentCol] or null. `i` is the first non-space index, `col` its column.
function scanListMarker(line, i, col) {
  const n = line.length;
  const c = line.charCodeAt(i);
  let ordered = false, startNum = 0, delim = 0, mLen = 0;
  if (c === 45 || c === 43 || c === 42) {
    delim = c; mLen = 1;
  } else if (isDigit(c)) {
    let j = i, num = 0, digits = 0;
    while (j < n && isDigit(line.charCodeAt(j)) && digits < 10) {
      num = num * 10 + (line.charCodeAt(j) - 48); j++; digits++;
    }
    if (digits === 0 || digits > 9) return null;
    if (j >= n) return null;
    const d = line.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    ordered = true; startNum = num; delim = d; mLen = j + 1 - i;
  } else return null;
  // The marker must be followed by 1+ spaces/tabs (or end of line).
  let j = i + mLen;
  if (j >= n) return [mLen, ordered, startNum, delim, -1, col + mLen];
  const nc = line.charCodeAt(j);
  if (nc !== 32 && nc !== 9) return null;
  // Count the spaces after the marker (columns).
  let spaces = 0, k = j, ccol = col + mLen;
  while (k < n) {
    const cc = line.charCodeAt(k);
    if (cc === 32) { k++; ccol++; spaces++; }
    else if (cc === 9) { const w = 4 - (ccol % 4); k++; ccol += w; spaces += w; }
    else break;
  }
  if (k >= n) return [mLen, ordered, startNum, delim, -1, col + mLen]; // empty item
  if (spaces === 0) return null;
  if (spaces >= 5) {
    // Content indent is marker + 1; the rest of the spaces are content indent.
    const ci = col + mLen + 1;
    return [mLen, ordered, startNum, delim, j + 1, ci, spaces - 1];
  }
  return [mLen, ordered, startNum, delim, k, ccol];
}

// HTML block start: returns the block type (1-7) or 0. `i` is the first
// non-space index (indent already <= 3).
const HTML_BLOCK_TAG_RE = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t/>]|$)/i;
function scanHtmlBlock(line, i) {
  if (line.charCodeAt(i) !== 60) return 0;
  const rest = line.slice(i);
  if (/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<!') && rest.length > 2 && isAlpha(rest.charCodeAt(2))) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  if (/^<\/?[A-Za-z][A-Za-z0-9-]*/.test(rest)) {
    const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    if (m && HTML_BLOCK_TAG_RE.test(m[1] + rest.slice(m[0].length, m[0].length + 1))) return 6;
    // A complete open/close tag on its own counts as type 7 only if it is
    // the whole line (checked by the caller via parseHtmlTag on the line).
    return 7;
  }
  return 0;
}

// Table delimiter row: returns the alignments array or null.
// `cells` are the raw cell strings (split on unescaped '|').
function parseTableDelim(cells) {
  const aligns = [];
  for (let cell of cells) {
    cell = cell.trim();
    if (cell.length === 0) return null;
    let left = false, right = false;
    if (cell.charCodeAt(0) === 58) { left = true; cell = cell.slice(1); }
    if (cell.length > 0 && cell.charCodeAt(cell.length - 1) === 58) { right = true; cell = cell.slice(0, -1); }
    if (cell.length === 0) return null;
    for (let k = 0; k < cell.length; k++) if (cell.charCodeAt(k) !== 45) return null;
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

// Split a table row on unescaped '|' outside code spans. Leading/trailing
// '|' produce empty edge cells that are dropped (if the row starts/ends
// with an unescaped '|').
function splitTableRow(line) {
  // Marked splits on EVERY unescaped '|' — code spans do NOT protect a
  // pipe ('| `a | b` |' splits into '`a' and 'b`'). Only '\|' is kept
  // (and unescaped to '|' in the cell).
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  // Skip a leading unescaped '|'.
  let start = 0;
  while (start < n && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  if (start < n && line.charCodeAt(start) === 124) i = start + 1;
  for (; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n && line.charCodeAt(i + 1) === 124) { cur += '|'; i++; continue; }
    if (c === 124) { cells.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  cells.push(cur);
  // Drop a trailing empty cell from a trailing unescaped '|'.
  let end = n - 1;
  while (end >= 0 && (line.charCodeAt(end) === 32 || line.charCodeAt(end) === 9)) end--;
  if (end >= 0 && line.charCodeAt(end) === 124) {
    // Make sure it is unescaped.
    let bs = 0, k = end - 1;
    while (k >= 0 && line.charCodeAt(k) === 92) { bs++; k--; }
    if (bs % 2 === 0) cells.pop();
  }
  return cells.map(c => c.trim());
}

// Link reference definition parser (works on a paragraph's joined text).
// Returns the end position (just after the def, incl. its trailing newline)
// or -1. Adds the ref to `refs` (first definition wins).
function parseDefTitle(s, i) {
  const q = s.charCodeAt(i);
  const close = q === 40 ? 41 : q;
  let j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isAsciiPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === close) return [unesc(s.slice(i + 1, j)), j + 1];
    if (q === 40 && c === 40) return null; // no nested '(' in def titles
    j++;
  }
  return null;
}

function parseRefDef(s, pos, refs) {
  const n = s.length;
  let i = pos;
  let sp = 0;
  while (i < n && s.charCodeAt(i) === 32 && sp < 4) { i++; sp++; }
  if (sp > 3) return -1;
  if (i >= n || s.charCodeAt(i) !== 91) return -1;
  let j = i + 1;
  let labelEnd = -1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; }
    if (c === 91) return -1;
    if (c === 93) { labelEnd = j; break; }
    if (c === 10 && j + 1 < n && s.charCodeAt(j + 1) === 10) return -1; // blank line in label
    j++;
  }
  if (labelEnd < 0) return -1;
  const rawLabel = s.slice(i + 1, labelEnd);
  if (rawLabel.length === 0 || rawLabel.length > 999) return -1;
  if (normLabel(rawLabel).length === 0) return -1; // whitespace-only label
  j = labelEnd + 1;
  if (j >= n || s.charCodeAt(j) !== 58) return -1;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) j++;
    else break;
  }
  if (j >= n) return -1;
  let dest = null;
  if (s.charCodeAt(j) === 60) {
    let k = j + 1;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92 && k + 1 < n) { k += 2; continue; }
      if (c === 62) break;
      if (c === 60 || c === 10) return -1;
      k++;
    }
    if (k >= n) return -1;
    dest = unesc(s.slice(j + 1, k));
    j = k + 1;
  } else {
    let k = j, depth = 0;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && k + 1 < n && isAsciiPunctCode(s.charCodeAt(k + 1))) { k += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      else if (c < 32) return -1;
      k++;
    }
    if (k === j || depth !== 0) return -1;
    dest = unesc(s.slice(j, k));
    j = k;
  }
  const key = normLabel(rawLabel);
  const store = (title) => { if (!refs.has(key)) refs.set(key, { href: dest, title }); };
  let k = j;
  while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
  const hadWS = k > j;
  if (k < n && s.charCodeAt(k) === 10) {
    let k2 = k + 1;
    while (k2 < n && (s.charCodeAt(k2) === 32 || s.charCodeAt(k2) === 9)) k2++;
    if (k2 < n) {
      const qc = s.charCodeAt(k2);
      if (qc === 34 || qc === 39 || qc === 40) {
        const t = parseDefTitle(s, k2);
        if (t) {
          let e = t[1];
          while (e < n && (s.charCodeAt(e) === 32 || s.charCodeAt(e) === 9)) e++;
          if (e >= n || s.charCodeAt(e) === 10) {
            if (e < n) e++;
            store(t[0]);
            return e;
          }
        }
        // Title on the next line is invalid (or junk follows it): the def
        // still stands without a title; the title line is left alone.
      }
    }
    store(null);
    return k + 1;
  }
  if (k < n) {
    const qc = s.charCodeAt(k);
    if (qc === 34 || qc === 39 || qc === 40) {
      if (!hadWS) return -1; // a title needs whitespace after the dest
      const t = parseDefTitle(s, k);
      if (!t) return -1;
      let e = t[1];
      while (e < n && (s.charCodeAt(e) === 32 || s.charCodeAt(e) === 9)) e++;
      if (e < n && s.charCodeAt(e) !== 10) return -1;
      if (e < n) e++;
      store(t[0]);
      return e;
    }
    return -1;
  }
  store(null);
  return k;
}

// Strip leading link reference definitions from a paragraph's joined text.
// Returns the remaining text.
function extractDefs(text, refs) {
  let pos = 0;
  for (;;) {
    const end = parseRefDef(text, pos, refs);
    if (end < 0) break;
    pos = end;
  }
  return text.slice(pos);
}

// Finalize a closed block node. Returns the node to keep in the parent's
// children, a replacement node, or null to remove it.
function finalizeBlock(node, refs) {
  if (node[0] === 'para') {
    let text = node[1].join('\n');
    text = extractDefs(text, refs);
    if (text.length === 0) return null;
    const lines = text.split('\n');
    // Table: second line must be a delimiter row with the same cell count,
    // and its indent must be <= 3 (4+ spaces = plain paragraph).
    if (lines.length >= 2) {
      const headerCells = splitTableRow(lines[0]);
      const delimCells = splitTableRow(lines[1]);
      let dind = 0, di = 0;
      while (di < lines[1].length) {
        const c = lines[1].charCodeAt(di);
        if (c === 32) { dind++; di++; }
        else if (c === 9) { dind += 4 - (dind % 4); di++; }
        else break;
      }
      if (dind <= 3 && headerCells.length === delimCells.length && headerCells.length > 0) {
        const aligns = parseTableDelim(delimCells);
        if (aligns) {
          const rows = [];
          for (let r = 2; r < lines.length; r++) {
            const cells = splitTableRow(lines[r]);
            while (cells.length < headerCells.length) cells.push('');
            rows.push(cells.slice(0, headerCells.length));
          }
          return ['table', headerCells, aligns, rows];
        }
      }
    }
    node[1] = lines;
    return node;
  }
  if (node[0] === 'code' && !node[3]) {
    // Indented code: strip trailing blank lines (whitespace-only).
    const lines = node[2];
    let e = lines.length;
    while (e > 0 && lines[e - 1].trim() === '') e--;
    node[2] = lines.slice(0, e);
    return node;
  }
  if (node[0] === 'code' && node[3]) {
    // Fenced code: remove exactly one trailing empty line (if present),
    // whether closed by a fence or by EOF.
    const lines = node[2];
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return node;
  }
  if (node[0] === 'html') {
    // HTML blocks: strip all trailing blank (whitespace-only) lines.
    const lines = node[2];
    let e = lines.length;
    while (e > 0 && lines[e - 1].trim() === '') e--;
    node[2] = lines.slice(0, e);
    return node;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Main block parse loop
// ---------------------------------------------------------------------------

// Does the line (content from column contentCol) start a block that can
// interrupt a paragraph? Used for the lazy-continuation check. A '==='
// setext underline does NOT interrupt (it is lazy-continued into the
// paragraph); '---' interrupts because it is also a thematic break.
function isInterruptingBlockStart(content, contentCol) {
  const [ind, ni, ncol] = measureIndent(content, 0, contentCol);
  if (ind > 3 || ni >= content.length) return false;
  const ch = content.charCodeAt(ni);
  if (ch === 62) return true; // blockquote
  if (ch === 35 && scanAtx(content, ni)) return true; // ATX
  if ((ch === 96 || ch === 126) && scanFence(content, ni)) return true; // fence
  if (ch === 60) {
    const ht = scanHtmlBlock(content, ni);
    if (ht >= 1 && ht <= 6) return true; // HTML types 1-6 (not 7)
  }
  if ((ch === 45 || ch === 42 || ch === 95) && scanThematicBreak(content, ni)) return true;
  const lm = scanListMarker(content, ni, ncol);
  if (lm && lm[4] !== -1 && (!lm[1] || lm[2] === 1)) return true; // interrupting list item
  return false;
}

// Does the line start ANY block (used for the lazy check inside list items,
// where any list marker ends the current item)? Like
// isInterruptingBlockStart, but any list marker counts.
function isBlockStart(content, contentCol) {
  const [ind, ni, ncol] = measureIndent(content, 0, contentCol);
  if (ind > 3 || ni >= content.length) return false;
  const ch = content.charCodeAt(ni);
  if (ch === 62) return true; // blockquote
  if (ch === 35 && scanAtx(content, ni)) return true;
  if ((ch === 96 || ch === 126) && scanFence(content, ni)) return true;
  if (ch === 60) {
    const ht = scanHtmlBlock(content, ni);
    if (ht >= 1 && ht <= 6) return true;
  }
  if ((ch === 45 || ch === 42 || ch === 95) && scanThematicBreak(content, ni)) return true;
  if (scanListMarker(content, ni, ncol)) return true;
  return false;
}

// Strip up to n leading whitespace characters from a fenced-code line.
// A tab counts as ONE character (consumed entirely when within the indent),
// unlike container matching which counts columns. Returns [line, col]
// where col is the column of the line's start.
function stripFenceIndent(line, n, col0) {
  let i = 0, col = col0;
  while (i < n && i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) { const w = 4 - (col % 4); i++; col += w; }
    else break;
  }
  return [line.slice(i), col];
}

// Expand leading tabs in a fenced-code line to spaces, based on the column.
// Only used inside containers (at the top level tabs stay literal).
function expandLeadingTabs(line, col0) {
  let col = col0, i = 0, out = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else if (c === 32) {
      out += ' ';
      col++;
      i++;
    } else break;
  }
  return out + line.slice(i);
}

function parseBlocks(lines, refs, endsWithNL) {
  const root = ['doc', []];
  const stack = [root];
  let pendingBlankStack = null;

  // Trailing-newline flag for an HTML block closed by condition on line ln:
  // true iff the next line is a real non-blank line, or (on the last line,
  // with a trailing newline in the input) the block is at the top level.
  function htmlFlagAfter(ln, isTopLevel) {
    if (ln + 1 >= lines.length) return isTopLevel && endsWithNL;
    // A whitespace-only (but non-empty) next line still yields the
    // trailing '\n'; only a truly EMPTY next line clears it.
    return lines[ln + 1].length > 0;
  }

  // Clear the trailing-\n flag on the last HTML block in a closing
  // container's subtree (it is no longer followed by content there).
  function clearLastHtmlFlag(node) {
    const kids = node[1];
    for (let k = kids.length - 1; k >= 0; k--) {
      const child = kids[k];
      if (child[0] === 'html') { child[4] = false; return; }
      if (child[0] === 'quote' || child[0] === 'list' || child[0] === 'item') {
        clearLastHtmlFlag(child);
        return;
      }
      return; // a non-HTML leaf ends the search
    }
  }

  // Loose-list decision (stack-based common prefix). Called at the end of
  // processing a non-blank line (after its blocks are built), so the stack
  // reflects where the line actually landed. A list is loose iff the blank
  // line sits between two items of it, or between two blocks in one item.
  function decideLoose() {
    if (!pendingBlankStack) return;
    const a = pendingBlankStack, b = stack;
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    p--;
    if (p >= 1) {
      const last = a[p];
      if (last[0] === 'list') {
        // Loose unless the blank line was inside a quote beyond the common
        // prefix (a quote line is part of the quote's content, not a
        // separator between items; a nested list does not shield it).
        let hasQuote = false;
        for (let d = p + 1; d < a.length; d++) {
          if (a[d][0] === 'quote') { hasQuote = true; break; }
        }
        if (!hasQuote) last[4] = false;
      } else if (last[0] === 'item') {
        for (let d = p - 1; d >= 1; d--) {
          if (a[d][0] === 'list') { a[d][4] = false; break; }
        }
      }
    }
    pendingBlankStack = null;
  }

  function closeTo(depth) {
    while (stack.length > depth) {
      const node = stack.pop();
      const parent = stack[stack.length - 1];
      const kids = parent[1];
      const repl = finalizeBlock(node, refs);
      if (repl === null) {
        if (kids[kids.length - 1] === node) kids.pop();
      } else if (repl !== node) {
        if (kids[kids.length - 1] === node) kids[kids.length - 1] = repl;
        else kids.push(repl);
      }
    }
  }

  // If the tip is a list, a non-list block must close it first (otherwise
  // the block lands inside the list as a phantom item).
  function closeListIfTip() {
    if (stack[stack.length - 1][0] === 'list') closeTo(stack.length - 1);
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const n = line.length;
    // ---- Phase 1: match open containers ----
    let pos = 0, col = 0, pend = 0;
    // tabCol: the column used for fenced-code tab expansion. A quote
    // contributes ONLY when it is the outermost container; a quote nested
    // inside a list item (or another quote) contributes 0. List items
    // always contribute their indent.
    let tabCol = 0, seenContainer = false;
    let lastContainer = stack.length - 1;
    const tipNode = stack[lastContainer];
    if (tipNode[0] === 'para' || tipNode[0] === 'code' || tipNode[0] === 'html') lastContainer--;
    let depth = 1;
    let matched = true;
    const lineIsBlank = isBlankLine(line, 0);
    // Always match containers, blank lines included: a blank line without
    // the quote marker closes the quote (lists/items are lenient — blank
    // lines never close them, they only mark lists loose).
    for (let d = 1; d <= lastContainer; d++) {
      const node = stack[d];
      if (node[0] === 'list') { depth = d + 1; continue; }
      if (node[0] === 'quote') {
        const [ind, ni, ncol] = measureIndent(line, pos, col + pend);
        if (ind > 3 || ni >= n || line.charCodeAt(ni) !== 62) { matched = false; break; }
        const colBefore = col;
        pos = ni + 1; col = ncol + 1; pend = 0;
        if (pos < n && line.charCodeAt(pos) === 32) { pos++; col++; }
        else if (pos < n && line.charCodeAt(pos) === 9) {
          // Tab width is computed from the RELATIVE column (within the
          // quote's parent container), not the absolute column: a '>'
          // at absolute column 7 (inside a list item) behaves like a
          // '>' at column 0 for the tab after it.
          const relCol = col - colBefore;
          const w = 4 - (relCol % 4);
          pos++; col++; pend += w - 1;
        }
        // A quote RESETS tabCol to its own content column relative to
        // its parent container (it does not accumulate list indents):
        // a fence inside nested lists + a quote expands tabs from 2,
        // not from 4. A nested quote resets to the same value.
        tabCol = col - colBefore;
        seenContainer = true;
        depth = d + 1;
        continue;
      }
      if (node[0] === 'item') {
        // node[3] is the item indent RELATIVE to its container's content
        // start (an absolute column breaks when the container's content
        // starts at a different column on a later line). Pending virtual
        // spaces (from a partial tab) count toward the indent.
        const relIndent = node[3];
        const target = col + relIndent;
        if (pend >= relIndent) {
          // Virtual spaces alone satisfy the indent; the excess is content.
          pend -= relIndent;
          col = target;
          tabCol += relIndent;
          seenContainer = true;
          depth = d + 1;
          continue;
        }
        const need = relIndent - pend;
        const [ni, ncol, spaces] = skipIndent(line, pos, col + pend, need);
        if (ncol < target && !lineIsBlank) {
          // A line that is blank AFTER the matched containers (e.g. a
          // lone '>' quote marker) never closes a list item: treat the
          // item as matched and let phase 2 handle the blank line.
          let restBlank = true;
          for (let q = pos; q < n; q++) {
            const cq = line.charCodeAt(q);
            if (cq !== 32 && cq !== 9) { restBlank = false; break; }
          }
          if (restBlank) {
            pos = ni; col = ncol; pend = spaces;
            tabCol += relIndent;
            seenContainer = true;
            depth = d + 1;
            continue;
          }
          // Fenced code inside a list item is lenient: a line that does
          // not match the item indent is still code content (fenced code
          // is indentation-insensitive), UNLESS it is a closing fence for
          // the tip fence (which must match the containers to close).
          // Quotes are NOT lenient (a missing '>' closes the quote).
          // Leniency applies ONLY once the fence already has content:
          // an unindented FIRST line closes the (empty) fence instead.
          if (tipNode[0] === 'code' && tipNode[3] && tipNode[2].length > 0) {
            const effContent = pend > 0 ? ' '.repeat(pend) + line.slice(pos) : line.slice(pos);
            const [ind2, ni2] = measureIndent(effContent, 0, col);
            let isClose = false;
            if (ind2 <= 3 && ni2 < effContent.length && effContent.charCodeAt(ni2) === tipNode[4]) {
              let len2 = 0;
              while (ni2 + len2 < effContent.length && effContent.charCodeAt(ni2 + len2) === tipNode[4]) len2++;
              if (len2 >= tipNode[5]) {
                let ok2 = true;
                for (let k = ni2 + len2; k < effContent.length; k++) {
                  const c2 = effContent.charCodeAt(k);
                  if (c2 !== 32 && c2 !== 9) { ok2 = false; break; }
                }
                if (ok2) isClose = true;
              }
            }
            if (!isClose) {
              // Treat the item as matched; the content is the raw line
              // (pos/col unchanged). Phase 3 adds it as code content.
              tabCol += relIndent;
              seenContainer = true;
              depth = d + 1;
              continue;
            }
          }
          matched = false; break;
        }
        pos = ni; col = ncol; pend = spaces;
        tabCol += relIndent;
        seenContainer = true;
        depth = d + 1;
        continue;
      }
    }
    const contentCol = col;
    let content = pend > 0 ? ' '.repeat(pend) + line.slice(pos) : line.slice(pos);
    // Lazy continuation: tip is a paragraph and the line does not start an
    // interrupting block. Inside a list item, ANY list marker prevents
    // laziness (it starts a new item or ends the list); at the top level,
    // only an interrupting marker does (bullet, or ordered starting at 1,
    // non-empty).
    let lazy = false;
    if (!matched && !lineIsBlank && content.length > 0) {
      const tip = stack[stack.length - 1];
      if (tip[0] === 'para') {
        let inList = false;
        for (let d = 1; d < stack.length; d++) {
          if (stack[d][0] === 'list') { inList = true; break; }
        }
        lazy = inList ? !isBlockStart(content, contentCol) : !isInterruptingBlockStart(content, contentCol);
      }
    }
    // A line is blank iff the RAW line is all whitespace, or the content
    // after the matched containers is empty. A line with markers plus
    // non-empty whitespace content (e.g. '>  ') is NOT blank.
    const blank = lineIsBlank || content.length === 0;
    if (!matched && !lazy) {
      // A container mismatch closes the containers: any HTML block inside
      // them loses its trailing newline (it is no longer followed by
      // content in its parent).
      for (let d = depth; d < stack.length; d++) {
        const nd = stack[d];
        if (nd[0] === 'html') nd[4] = false;
        else if (nd[0] === 'quote' || nd[0] === 'list' || nd[0] === 'item') clearLastHtmlFlag(nd);
      }
      closeTo(depth);
    }

    // ---- Phase 2: blank line ----
    if (blank) {
      const tip = stack[stack.length - 1];
      if (tip[0] === 'code') {
        if (tip[3]) {
          // Fenced code: preserve the line's spaces (backtick fences strip
          // up to the opening indent; tilde fences strip nothing).
          if (tip[4] === 96) {
            let [line, lcol] = stripFenceIndent(content, tip[6], tabCol);
            if (contentCol > 0) line = expandLeadingTabs(line, lcol);
            tip[2].push(line);
          } else {
            let line = content;
            if (contentCol > 0) line = expandLeadingTabs(line, tabCol);
            tip[2].push(line);
          }
        } else {
          // Indented code: strip 4 (a 6-space blank contributes 2 spaces).
          const [ci, , cspaces] = skipIndent(content, 0, contentCol, 4);
          tip[2].push(' '.repeat(cspaces) + content.slice(ci));
        }
      } else if (tip[0] === 'html') {
        if (tip[3] <= 5) tip[2].push(content);
        else closeTo(stack.length - 1);
      } else if (tip[0] === 'para') {
        // Table quirk: a whitespace-only line ending in a tab that
        // expands to exactly 4 columns is a TABLE ROW, not a blank line
        // (it does not end the paragraph/table). Only when the paragraph
        // is already a table (header + delimiter row).
        const pls = tip[1];
        let isTabRow = false;
        if (pls.length >= 2 && content.length > 0 && content.charCodeAt(content.length - 1) === 9) {
          let w = 0, allWs = true;
          for (let q = 0; q < content.length; q++) {
            const cq = content.charCodeAt(q);
            if (cq === 32) w++;
            else if (cq === 9) w += 4 - (w % 4);
            else { allWs = false; break; }
          }
          if (allWs && w === 4) {
            const hc = splitTableRow(pls[0]);
            const dc = splitTableRow(pls[1]);
            if (hc.length === dc.length && hc.length > 0 && parseTableDelim(dc)) isTabRow = true;
          }
        }
        if (isTabRow) {
          tip[1].push(content);
        } else {
          closeTo(stack.length - 1);
        }
      }
      // A blank line closes an empty list item (one with no content blocks
      // yet): content after the blank line is outside the item.
      while (stack.length > 1 && stack[stack.length - 1][0] === 'item' && stack[stack.length - 1][1].length === 0) {
        closeTo(stack.length - 1);
      }
      // Loose-list marking: remember the stack at the blank line; the next
      // non-blank line decides which list (if any) is loose by the longest
      // common prefix of the two stacks.
      if (tip[0] !== 'code' && !(tip[0] === 'html' && tip[3] <= 5)) {
        pendingBlankStack = stack.slice();
      }
      continue;
    }

    if (lazy) {
      const para = stack[stack.length - 1];
      // A lazy setext underline ('===') is added with exactly 4 spaces of
      // indentation (so it stays paragraph text, not a heading underline).
      const [lind, lni] = measureIndent(content, 0, contentCol);
      if (lind <= 3 && lni < content.length && content.charCodeAt(lni) === 61 && scanSetext(content, lni) === 1) {
        para[1].push('    ' + content.slice(lni).trimStart());
      } else if (lind >= 4) {
        // Lazy line with 4+ leading spaces: strip exactly 4.
        const [ci, , cspaces] = skipIndent(content, 0, contentCol, 4);
        para[1].push(' '.repeat(cspaces) + content.slice(ci));
      } else {
        // Leading tabs expand (from tabCol) inside a container.
        let lazyLine = content;
        if (tabCol > 0) {
          const fc = lazyLine.charCodeAt(0);
          if (fc === 9 || fc === 32) lazyLine = expandLeadingTabs(lazyLine, tabCol);
        }
        para[1].push(lazyLine);
      }
      decideLoose();
      continue;
    }

    // ---- Phase 3: leaf continuation ----
    let tip = stack[stack.length - 1];
    if (tip[0] === 'code' && tip[3]) {
      const [ind, ni] = measureIndent(content, 0, contentCol);
      let closed = false;
      if (ind <= 3 && ni < content.length && content.charCodeAt(ni) === tip[4]) {
        let len = 0;
        while (ni + len < content.length && content.charCodeAt(ni + len) === tip[4]) len++;
        if (len >= tip[5]) {
          let ok = true;
          for (let k = ni + len; k < content.length; k++) {
            const c = content.charCodeAt(k);
            if (c !== 32 && c !== 9) { ok = false; break; }
          }
          if (ok) closed = true;
        }
      }
      if (closed) { closeTo(stack.length - 1); decideLoose(); continue; }
      if (tip[4] === 96) {
        let [line, lcol] = stripFenceIndent(content, tip[6], tabCol);
        if (contentCol > 0) line = expandLeadingTabs(line, lcol);
        tip[2].push(line);
      } else {
        let line = content;
        if (contentCol > 0) line = expandLeadingTabs(line, tabCol);
        tip[2].push(line);
      }
      decideLoose();
      continue;
    }
    if (tip[0] === 'html') {
      tip[2].push(content);
      let closeIt = false;
      if (tip[3] === 1 && /<\/(?:script|pre|style|textarea)>/i.test(content)) closeIt = true;
      else if (tip[3] === 2 && content.indexOf('-->') >= 0) closeIt = true;
      else if (tip[3] === 3 && content.indexOf('?>') >= 0) closeIt = true;
      else if (tip[3] === 4 && content.indexOf('>') >= 0) closeIt = true;
      else if (tip[3] === 5 && content.indexOf(']]>') >= 0) closeIt = true;
      if (closeIt) {
        tip[4] = htmlFlagAfter(ln, stack.length === 2);
        closeTo(stack.length - 1);
      }
      decideLoose();
      continue;
    }
    if (tip[0] === 'code' && !tip[3]) {
      const [ind, ni, ncol] = measureIndent(content, 0, contentCol);
      if (ind >= 4) {
        const [ci, ccol, cspaces] = skipIndent(content, 0, contentCol, 4);
        tip[2].push(' '.repeat(cspaces) + content.slice(ci));
        decideLoose();
        continue;
      }
      closeTo(stack.length - 1);
      tip = stack[stack.length - 1];
    }

    // ---- Phase 4: new block starts ----
    let cpos = 0, ccol = contentCol;
    let done = false;
    while (!done) {
      const [ind, ni, ncol] = measureIndent(content, cpos, ccol);
      if (ni >= content.length) {
        // Whitespace-only line (after markers): it continues a paragraph
        // as a whitespace line (e.g. '>  ' adds ' ' to the paragraph).
        if (tip[0] === 'para') tip[1].push(content.slice(cpos));
        done = true; break;
      }
      const ch = content.charCodeAt(ni);
      tip = stack[stack.length - 1];
      const inPara = tip[0] === 'para';

      // Blockquote.
      if (ind <= 3 && ch === 62) {
        if (inPara) closeTo(stack.length - 1);
        closeListIfTip();
        const q = ['quote', []];
        stack[stack.length - 1][1].push(q);
        stack.push(q);
        cpos = ni + 1; ccol = ncol + 1;
        if (cpos < content.length && content.charCodeAt(cpos) === 32) { cpos++; ccol++; }
        else if (cpos < content.length && content.charCodeAt(cpos) === 9) {
          const w = 4 - (ccol % 4);
          content = content.slice(0, cpos) + ' '.repeat(w - 1) + content.slice(cpos + 1);
          ccol++;
        }
        continue;
      }

      // ATX heading.
      if (ind <= 3 && ch === 35) {
        const atx = scanAtx(content, ni);
        if (atx) {
          if (inPara) closeTo(stack.length - 1);
          closeListIfTip();
          const head = ['head', atx[0], [content.slice(atx[1], atx[2])]];
          stack[stack.length - 1][1].push(head);
          done = true; break;
        }
      }

      // Fenced code.
      if (ind <= 3 && (ch === 96 || ch === 126)) {
        const fn = scanFence(content, ni);
        if (fn) {
          if (inPara) closeTo(stack.length - 1);
          closeListIfTip();
          const node = ['code', [], [], true, ch, fn[1], ind];
          let infoEnd = fn[2];
          while (infoEnd < fn[3] && content.charCodeAt(infoEnd) !== 32 && content.charCodeAt(infoEnd) !== 9) infoEnd++;
          node[7] = unesc(content.slice(fn[2], infoEnd));
          stack[stack.length - 1][1].push(node);
          stack.push(node);
          done = true; break;
        }
      }

      // HTML block.
      if (ind <= 3 && ch === 60) {
        const ht = scanHtmlBlock(content, ni);
        let ok = false;
        if (ht && (ht <= 6 || !inPara)) {
          if (ht === 7) {
            // Type 7 requires the line to be a single complete tag
            // (plus optional trailing spaces).
            const tag = parseHtmlTag(content, ni);
            if (tag) {
              let e = tag[1];
              while (e < content.length && (content.charCodeAt(e) === 32 || content.charCodeAt(e) === 9)) e++;
              if (e >= content.length) ok = true;
            }
          } else ok = true;
        }
        if (ok) {
          if (inPara) closeTo(stack.length - 1);
          closeListIfTip();
          const node = ['html', [], [content.slice(cpos)], ht, false];
          stack[stack.length - 1][1].push(node);
          stack.push(node);
          const rest = content.slice(ni);
          let closeIt = false;
          if (ht === 1 && /<\/(?:script|pre|style|textarea)>/i.test(rest)) closeIt = true;
          else if (ht === 2 && rest.indexOf('-->') >= 0) closeIt = true;
          else if (ht === 3 && rest.indexOf('?>') >= 0) closeIt = true;
          else if (ht === 4 && rest.indexOf('>') >= 0) closeIt = true;
          else if (ht === 5 && rest.indexOf(']]>') >= 0) closeIt = true;
          if (closeIt) {
            node[4] = htmlFlagAfter(ln, stack.length === 2);
            closeTo(stack.length - 1);
          }
          done = true; break;
        }
      }

      // Setext heading (paragraph only). A paragraph that is a table
      // (header + delimiter row) is NOT converted: the underline line
      // becomes another table row.
      if (inPara && ind <= 3 && (ch === 61 || ch === 45)) {
        const st = scanSetext(content, ni);
        if (st) {
          const para = stack[stack.length - 1];
          const pls = para[1];
          let isTable = false;
          if (pls.length >= 2) {
            const hc = splitTableRow(pls[0]);
            const dc = splitTableRow(pls[1]);
            if (hc.length === dc.length && hc.length > 0 && parseTableDelim(dc)) isTable = true;
          }
          if (isTable) {
            // Fall through to the paragraph continuation below.
          } else {
          let text = para[1].join('\n');
          text = extractDefs(text, refs);
          text = text.trim();
          if (text.length > 0) {
            stack.pop();
            const parent = stack[stack.length - 1];
            const kids = parent[1];
            const head = ['head', st, text.split('\n')];
            const idx = kids.indexOf(para);
            if (idx >= 0) kids[idx] = head; else kids.push(head);
            done = true; break;
          } else {
            stack.pop();
            const parent = stack[stack.length - 1];
            const kids = parent[1];
            const idx = kids.indexOf(para);
            if (idx >= 0) kids.splice(idx, 1);
            continue;
          }
          }
        }
      }

      // Thematic break.
      if (ind <= 3 && (ch === 45 || ch === 42 || ch === 95)) {
        if (scanThematicBreak(content, ni)) {
          if (inPara) closeTo(stack.length - 1);
          closeListIfTip();
          stack[stack.length - 1][1].push(['hr', []]);
          done = true; break;
        }
      }

      // List item.
      if (ind <= 3) {
        const lm = scanListMarker(content, ni, ncol);
        if (lm) {
          // scanListMarker: [mLen, ordered, startNum, delim, contentIdx,
          // contentCol, extraSpaces?]. contentIdx is -1 for an empty item.
          const isOrdered = lm[1];
          const listType = isOrdered ? 'ol' : 'ul';
          // Can it interrupt a paragraph? Ordered lists need start 1 and the
          // item must be non-empty — EXCEPT inside a list item, where ANY
          // list marker interrupts (even ordered start != 1).
          let canInterrupt = true;
          if (inPara) {
            let inList = false;
            for (let d = 1; d < stack.length; d++) {
              if (stack[d][0] === 'list') { inList = true; break; }
            }
            if (isOrdered && lm[2] !== 1 && !inList) canInterrupt = false;
            else if (lm[4] === -1) canInterrupt = false;
          }
          if (canInterrupt) {
            if (inPara) closeTo(stack.length - 1);
            // A marker at an absolute column STRICTLY LESS than the
            // current item's marker column belongs to an OUTER list: close
            // the item (and its parent list) and re-check, walking up
            // until the tip is a list the marker can join or the doc. (A
            // marker at the SAME column is a sibling item in the same
            // list; a MORE indented marker is a nested list.)
            tip = stack[stack.length - 1];
            while (tip[0] === 'item' && tip[4] !== undefined && ncol < tip[4]) {
              // Close the item and its parent list.
              closeTo(stack.length - 2);
              tip = stack[stack.length - 1];
            }
            // A marker at the SAME column as the current item's marker is
            // a SIBLING item: close the item (not its list) so the tip is
            // the list the new item joins.
            if (tip[0] === 'item' && tip[4] !== undefined && ncol === tip[4]) {
              closeTo(stack.length - 1);
              tip = stack[stack.length - 1];
            }
            // Find or create the list.
            let list = null;
            tip = stack[stack.length - 1];
            if (tip[0] === 'list' && tip[2] === listType && tip[3] === lm[3]) {
              list = tip;
            } else {
              if (tip[0] === 'list') closeTo(stack.length - 1);
              list = ['list', [], listType, lm[3], true, isOrdered ? lm[2] : 0];
              stack[stack.length - 1][1].push(list);
              stack.push(list);
            }
            // The >= 5 spaces case with a leading tab: expand the tab in
            // place so the content start (after 1 space) is correct.
            if (lm[6] !== undefined && content.charCodeAt(ni + lm[0]) === 9) {
              const tc = ncol + lm[0];
              const w = 4 - (tc % 4);
              content = content.slice(0, ni + lm[0]) + ' '.repeat(w) + content.slice(ni + lm[0] + 1);
            }
            const emptyItem = lm[4] === -1;
            // Item indent is RELATIVE to the container's content start
            // (ccol), not absolute: the container's content may start at a
            // different column on a later line. The marker's ABSOLUTE
            // column (ncol) is stored so a later marker at a lower-or-equal
            // column can be recognised as belonging to an outer list.
            const itemIndent = emptyItem ? lm[5] + 1 - ccol : lm[5] - ccol;
            const item = ['item', [], null, itemIndent, ncol];
            list[1].push(item);
            stack.push(item);
            if (emptyItem) { done = true; break; }
            cpos = lm[4]; ccol = lm[5];
            // Task marker? Must be at the content start, followed by a space
            // and non-space content.
            if (content.charCodeAt(cpos) === 91) {
              const tm = content.slice(cpos, cpos + 4);
              if ((tm === '[ ] ' || tm === '[x] ' || tm === '[X] ') && cpos + 4 < content.length) {
                let after = cpos + 4;
                while (after < content.length && content.charCodeAt(after) === 32) after++;
                if (after < content.length) {
                  item[2] = tm[1] === ' ' ? ' ' : 'x';
                  cpos = after; ccol = lm[5] + (after - lm[4]);
                }
              }
            }
            if (cpos >= content.length) { done = true; break; }
            continue;
          }
        }
      }

      // Indented code (not in a paragraph).
      if (!inPara && ind >= 4) {
        closeListIfTip();
        const [ci, ccol2, cspaces] = skipIndent(content, cpos, ccol, 4);
        const node = ['code', [], [' '.repeat(cspaces) + content.slice(ci)], false];
        stack[stack.length - 1][1].push(node);
        stack.push(node);
        done = true; break;
      }

      // Paragraph (continue or start). Leading tabs are expanded (from
      // tabCol) when inside a container; at the top level they stay
      // literal. Only leading tabs are expanded, never mid-line ones.
      let paraLine = content.slice(cpos);
      if (tabCol > 0) {
        const fc = paraLine.charCodeAt(0);
        if (fc === 9 || fc === 32) paraLine = expandLeadingTabs(paraLine, tabCol);
      }
      if (inPara) {
        tip[1].push(paraLine);
      } else {
        closeListIfTip();
        const para = ['para', [paraLine]];
        stack[stack.length - 1][1].push(para);
        stack.push(para);
      }
      done = true; break;
    }
    decideLoose();
  }
  // EOF: an HTML block still open keeps its trailing newline only if it is
  // a direct child of the document, the input ends with a newline, and the
  // last line is not blank (a trailing blank line means no trailing \n).
  const lastNonBlank = lines.length > 0 && !isBlankLine(lines[lines.length - 1], 0);
  for (let d = 1; d < stack.length; d++) {
    if (stack[d][0] === 'html') stack[d][4] = endsWithNL && lastNonBlank && d === 1;
  }
  closeTo(1);
  return root;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTable(node, refs, out, state) {
  const header = node[1], aligns = node[2], rows = node[3];
  out.push('<table>\n<thead>\n<tr>\n');
  for (let i = 0; i < header.length; i++) {
    const a = aligns[i];
    out.push('<th');
    if (a) out.push(' align="', a, '"');
    out.push('>', renderInline(header[i], refs, state), '</th>\n');
  }
  out.push('</tr>\n</thead>\n');
  if (rows.length > 0) {
    out.push('<tbody>');
    for (const row of rows) {
      out.push('<tr>\n');
      for (let i = 0; i < row.length; i++) {
        const a = aligns[i];
        out.push('<td');
        if (a) out.push(' align="', a, '"');
        out.push('>', renderInline(row[i], refs, state), '</td>\n');
      }
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
}

function renderItem(item, tight, refs, out, state) {
  out.push('<li>');
  const kids = item[1];
  let taskHtml = '';
  if (item[2] !== null) {
    taskHtml = item[2] === 'x'
      ? '<input checked="" disabled="" type="checkbox"> '
      : '<input disabled="" type="checkbox"> ';
  }
  let taskPlaced = false;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (i === 0 && taskHtml && child[0] !== 'para') {
      out.push(taskHtml);
      taskPlaced = true;
    }
    if (child[0] === 'para') {
      const inner = renderInline(child[1].join('\n'), refs, state);
      if (tight) {
        if (i === 0 && taskHtml) { out.push(taskHtml); taskPlaced = true; }
        out.push(inner);
      } else {
        out.push('<p>');
        if (i === 0 && taskHtml) { out.push(taskHtml); taskPlaced = true; }
        out.push(inner, '</p>\n');
      }
    } else {
      renderBlocks([child], refs, out, state);
    }
  }
  if (taskHtml && !taskPlaced) out.push(taskHtml);
  out.push('</li>\n');
}

function renderBlocks(kids, refs, out, state) {
  if (!state) state = { suppressAutolinks: false };
  for (const node of kids) {
    const t = node[0];
    if (t === 'para') {
      out.push('<p>', renderInline(node[1].join('\n'), refs, state), '</p>\n');
    } else if (t === 'head') {
      const lv = String(node[1]);
      out.push('<h', lv, '>', renderInline(node[2].join('\n'), refs, state), '</h', lv, '>\n');
    } else if (t === 'code') {
      const lines = node[2];
      const text = lines.length ? lines.join('\n') + '\n' : '';
      let cls = '';
      if (node[3] && node[7]) cls = ' class="language-' + escAttr(node[7]) + '"';
      out.push('<pre><code', cls, '>', escLiteral(text), '</code></pre>\n');
    } else if (t === 'html') {
      out.push(node[2].join('\n'));
      if (node[4]) out.push('\n');
    } else if (t === 'quote') {
      out.push('<blockquote>\n');
      renderBlocks(node[1], refs, out, state);
      out.push('</blockquote>\n');
    } else if (t === 'list') {
      const tight = node[4];
      if (node[2] === 'ol') {
        out.push(node[5] !== 1 ? '<ol start="' + node[5] + '">\n' : '<ol>\n');
      } else {
        out.push('<ul>\n');
      }
      for (const item of node[1]) renderItem(item, tight, refs, out, state);
      out.push(node[2] === 'ol' ? '</ol>\n' : '</ul>\n');
    } else if (t === 'hr') {
      out.push('<hr>\n');
    } else if (t === 'table') {
      renderTable(node, refs, out, state);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parse(markdown) {
  const text = String(markdown).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const endsWithNL = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsWithNL) lines.pop();
  const refs = new Map();
  const root = parseBlocks(lines, refs, endsWithNL);
  const out = [];
  renderBlocks(root[1], refs, out);
  return out.join('');
}

export { parse };
