import * as assert from 'node:assert/strict';
import test from 'node:test';
import { decodeWslOutput, parseWslDistributions } from '../wslUtils';

test('decodes UTF-16 WSL output and detects the default distribution', () => {
  const text = '  NAME                   STATE           VERSION\r\n* Ubuntu                 Running         2\r\n  Debian                 Stopped         2\r\n';
  const parsed = parseWslDistributions(decodeWslOutput(Buffer.from(text, 'utf16le')));
  assert.deepEqual(parsed, [
    { name: 'Ubuntu', isDefault: true },
    { name: 'Debian', isDefault: false },
  ]);
});

test('ignores localized headings while retaining distribution rows', () => {
  const parsed = parseWslDistributions('名称                    状态            版本\n  Ubuntu                Running         2\n');
  assert.deepEqual(parsed, [{ name: 'Ubuntu', isDefault: false }]);
});
