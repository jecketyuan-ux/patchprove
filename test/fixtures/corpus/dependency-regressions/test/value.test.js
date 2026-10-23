import { test } from 'node:test';
import assert from 'node:assert/strict';
import { value } from '../src/value.js';
test('value is a number', () => assert.equal(typeof value, 'number'));
