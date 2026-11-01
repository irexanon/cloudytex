/** Pure offset parsers shared by provider adapters and tests; offsets are exclusive byte positions. */
export function parseOneDriveNextOffset(ranges: unknown, totalBytes: number, fallback = 0): number {
  if (!Array.isArray(ranges) || ranges.length === 0) return fallback;
  const match = String(ranges[0]).match(/^(\d+)-/);
  if (!match) throw new Error('OneDrive returned an invalid nextExpectedRanges value');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) throw new Error('OneDrive returned an out-of-range nextExpectedRanges offset');
  return offset;
}

export function parseGoogleRangeOffset(rangeHeader: unknown, totalBytes: number): number {
  if (rangeHeader == null || rangeHeader === '') return 0;
  if (typeof rangeHeader !== 'string') throw new Error('Google Drive returned a non-string Range acknowledgement');
  const match = rangeHeader.match(/^bytes=0-(\d+)$/);
  if (!match) throw new Error('Google Drive returned an invalid Range acknowledgement');
  const offset = Number(match[1]) + 1;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) throw new Error('Google Drive returned an out-of-range Range offset');
  return offset;
}
