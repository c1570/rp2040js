import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * cpu.ts keeps its own copies of decode.ts's T_* tag values so its dispatch
 * switch has literal case labels (see the comment there). Nothing at compile
 * time ties the two lists together, and a drift would silently execute the
 * wrong instruction, so check them here.
 *
 * Read from source rather than from exports: the values are deliberately
 * module-private in cpu.ts, and parsing can't under-cover the way a hand-kept
 * export list could.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Strip comments so prose mentioning a tag can't be mistaken for a definition. */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every `T_NAME = <number>` declaration, covering both the one-per-line form in
 * cpu.ts and the comma-separated `export const A = 1, B = 2;` form in decode.ts. */
function parseTags(file: string): Record<string, number> {
  const source = stripComments(readFileSync(join(here, '..', file), 'utf-8'));
  const tags: Record<string, number> = {};
  for (const m of source.matchAll(/\b(T_[A-Z0-9_]+)\s*=\s*(\d+)\b/g)) {
    expect(tags[m[1]], `${file} declares ${m[1]} more than once`).toBeUndefined();
    tags[m[1]] = Number(m[2]);
  }
  return tags;
}

describe('RISC-V decode tags', () => {
  const inCpu = parseTags('cpu.ts');
  const inDecode = parseTags('decode.ts');

  // If a refactor breaks the parsing above, fail loudly here rather than
  // silently comparing two empty objects and passing.
  it('finds the tag declarations in both files', () => {
    expect(Object.keys(inDecode).length).toBeGreaterThan(100);
    expect(Object.keys(inCpu).length).toBeGreaterThan(100);
  });

  it('cpu.ts declares exactly the tags decode.ts does', () => {
    // Sorted arrays rather than sets so a failure names the offending tag.
    expect(Object.keys(inCpu).sort()).toEqual(Object.keys(inDecode).sort());
  });

  it('every tag has the same value in both files', () => {
    expect(inCpu).toEqual(inDecode);
  });

  it('tag values are unique and densely packed from 0', () => {
    const values = Object.values(inDecode).sort((a, b) => a - b);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(values.map((_, i) => i));
  });
});
