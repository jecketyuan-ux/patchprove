import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spare } from './spare.js';
test('spare', () => assert.equal(spare, 4));
