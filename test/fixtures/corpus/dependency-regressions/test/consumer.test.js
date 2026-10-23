import { test } from 'node:test';
import assert from 'node:assert/strict';
import { double } from './shared.test.js';
test('double two', () => assert.equal(double(2), 4));
