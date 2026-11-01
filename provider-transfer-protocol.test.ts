import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleRangeOffset, parseOneDriveNextOffset } from './provider-transfer-protocol.ts';

test('OneDrive parses the first expected range as the committed exclusive offset', () => {
  assert.equal(parseOneDriveNextOffset(['0-'], 100), 0);
  assert.equal(parseOneDriveNextOffset(['3276800-'], 10_000_000), 3_276_800);
  assert.equal(parseOneDriveNextOffset(['100-200', '400-'], 1_000), 100);
});

test('OneDrive empty ranges use the caller fallback and malformed/out-of-range offsets fail', () => {
  assert.equal(parseOneDriveNextOffset([], 100, 45), 45);
  assert.throws(() => parseOneDriveNextOffset(['x-'], 100));
  assert.throws(() => parseOneDriveNextOffset(['101-'], 100));
});

test('Google Drive 308 Range is converted to an exclusive offset; missing Range means zero', () => {
  assert.equal(parseGoogleRangeOffset(undefined, 100), 0);
  assert.equal(parseGoogleRangeOffset('bytes=0-0', 100), 1);
  assert.equal(parseGoogleRangeOffset('bytes=0-8388607', 16_777_216), 8_388_608);
});

test('Google Drive rejects malformed and out-of-range acknowledgements', () => {
  assert.throws(() => parseGoogleRangeOffset('bytes=1-2', 100));
  assert.throws(() => parseGoogleRangeOffset('bytes=0-100', 100));
});
