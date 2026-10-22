import { test } from 'node:test';
import assert from 'node:assert/strict';
const moduleName = '../src/' + 'value.js';
test('dynamic import', async () => assert.equal((await import(moduleName)).value, 2));
