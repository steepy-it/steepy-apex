import { writeSync } from 'node:fs';

export function writeAllSync(fd, value, writeToFd = writeSync) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const written = writeToFd(fd, bytes, offset, remaining);
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      throw new Error(`invalid write count: ${String(written)} for ${remaining} remaining bytes`);
    }
    offset += written;
  }
  return offset;
}
