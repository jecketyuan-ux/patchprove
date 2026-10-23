import { test } from 'node:test';
import assert from 'node:assert/strict';
const open = '/*';
import { value } from '../src/value.js';
const close = '*/';
test('value keeps its public result', () => assert.equal(value, 2));
