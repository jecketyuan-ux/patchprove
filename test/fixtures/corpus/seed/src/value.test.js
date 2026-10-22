import { test } from 'node:test';
import assert from 'node:assert/strict';
import { value } from './value.js';
test('value', () => assert.equal(value, 2));
