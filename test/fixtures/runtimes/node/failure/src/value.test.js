import { expect, test } from 'vitest';
import { value } from './value.js';
test('value', () => expect(value()).toBe(3));
