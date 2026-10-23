import { test } from 'node:test';
import assert from 'node:assert/strict';
export const double = value => value * 2;
test('double zero', () => assert.equal(double(0), 0));
