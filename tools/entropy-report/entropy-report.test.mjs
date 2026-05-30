#!/usr/bin/env node
/**
 * Tokenizer correctness tests for entropy-report.mjs.
 *
 * Covers findings F1–F6 from ticket #50. Run with:
 *   node --test tools/entropy-report/entropy-report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, computeHalstead } from './entropy-report.mjs';

/** Sum of all counts in a Map. */
const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);

// ── F1: template-literal interpolations are tokenized, not swallowed ─────────
test('F1 — operators and identifiers inside ${…} are counted', () => {
  const plain = tokenize('const x = a + b * 2;');
  const tmpl = tokenize('const x = `${a + b * 2}`;');

  // The interpolation must contribute its arithmetic operators.
  assert.ok(tmpl.operators.has('+'), 'expected + from interpolation');
  assert.ok(tmpl.operators.has('*'), 'expected * from interpolation');
  assert.ok(tmpl.operands.has('a') && tmpl.operands.has('b'), 'expected a,b operands');

  // It should see essentially the same operators as the non-template form.
  assert.ok(total(tmpl.operators) >= total(plain.operators) - 1,
    'template form lost operators that the plain form has');
});

test('F1 — nested interpolations and method calls recurse', () => {
  const { operators, operands } = tokenize('const s = `a ${Math.max(x, `${y}`)} b`;');
  assert.ok(operands.has('Math'));
  assert.ok(operands.has('max'));
  assert.ok(operands.has('x'));
  assert.ok(operands.has('y'));
  assert.ok(operators.has('('));
  assert.ok(operators.has(','));
});

// ── F2: regex literals are a single operand, not operator soup ───────────────
test('F2 — /[-:]/g is one operand', () => {
  const { operators, operands } = tokenize("str.replace(/[-:]/g, '');");
  const regexOperands = [...operands.keys()].filter(k => k.startsWith('re:'));
  assert.equal(regexOperands.length, 1, 'expected exactly one regex operand');
  // The bracket/colon/dash inside the regex must NOT register as operators.
  assert.ok(!operators.has(':'), 'colon inside regex leaked as operator');
  assert.ok(!operators.has('['), 'bracket inside regex leaked as operator');
});

test('F2 — division is not mistaken for a regex', () => {
  const { operands } = tokenize('const r = a / b / c;');
  const regexOperands = [...operands.keys()].filter(k => k.startsWith('re:'));
  assert.equal(regexOperands.length, 0, 'division misread as regex');
});

// ── F3: regex bodies containing comment-like sequences survive ───────────────
test('F3 — regex body with /* … */ and // is preserved', () => {
  const { operands } = tokenize('const re = /\\/\\*foo\\*\\//; const u = used;');
  // `used` appears after the regex; if the regex body had been eaten as a
  // block comment, the trailing code would vanish.
  assert.ok(operands.has('used'), 'code after a comment-like regex was dropped');
  assert.equal([...operands.keys()].filter(k => k.startsWith('re:')).length, 1);
});

// ── F4: quote style does not fork string operands ────────────────────────────
test('F4 — \'foo\', "foo" and `foo` are the same operand', () => {
  const { operands } = tokenize('const a = \'foo\'; const b = "foo"; const c = `foo`;');
  const fooKeys = [...operands.keys()].filter(k => k === 'str:foo');
  assert.equal(fooKeys.length, 1, 'quote styles produced distinct operands');
  assert.equal(operands.get('str:foo'), 3, 'expected all three to collapse to count 3');
});

// ── F5: numeric edge cases are single operands ───────────────────────────────
test('F5 — 1_000_000, 0xffn and .5 each tokenize as one numeric operand', () => {
  for (const [src, norm] of [['1_000_000', '1000000'], ['0xffn', '0xffn'], ['.5', '.5']]) {
    const { operands } = tokenize(`const n = ${src};`);
    assert.ok(operands.has('num:' + norm),
      `expected single numeric operand num:${norm} for ${src}`);
  }
  // Separator equivalence: 1_000 and 1000 are the same operand.
  const { operands } = tokenize('const a = 1_000; const b = 1000;');
  assert.equal(operands.get('num:1000'), 2);
});

// ── F6 sanity: union-map Volume exceeds the sum of per-file Volumes ──────────
test('F6 — project Volume from union maps >= sum of per-file Volumes', () => {
  const fileA = 'export function alpha(x) { return x + 1; }';
  const fileB = 'export const beta = (y) => y * 2;';

  const sumPerFile =
    computeHalstead(fileA).volume + computeHalstead(fileB).volume;
  const union = computeHalstead(fileA + '\n' + fileB).volume;

  assert.ok(union >= sumPerFile,
    `union Volume ${union} should be >= per-file sum ${sumPerFile}`);
});

// ── Smoke: a representative snippet tokenizes without throwing ───────────────
test('smoke — mixed TypeScript tokenizes and yields positive Volume', () => {
  const src = `
    import { z } from 'zod';
    /** doc */
    export class Foo<T> {
      private readonly re = /^[a-z]+$/i;
      greet(name: string): string {
        return \`hello \${name.toUpperCase()}, \${1_000} times\`;
      }
    }
  `;
  const h = computeHalstead(src);
  assert.ok(h.volume > 0);
  assert.ok(h.difficulty > 0);
});