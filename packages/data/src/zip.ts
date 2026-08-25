/**
 * A ZIP reader, in about a hundred lines.
 *
 * B3 ships its daily price report as a zip containing a zip containing XML, and Node has no zip
 * reader. The alternatives were a dependency or this. A dependency would be the third runtime
 * package in a repository that has two, for a format whose readable subset — stored and deflated
 * entries, no encryption, no spanning — is a central directory and a call to `inflateRaw`. The
 * same argument that produced the `.tape` format instead of Parquet (ADR-0009) applies here, and
 * `zlib` is already in the standard library doing all the actual work.
 *
 * What it does not do, and says so rather than guessing: ZIP64, encrypted entries, and multi-disk
 * archives all throw. A file that needs one of those is a file this was not written for, and
 * silently misreading its offsets would produce garbage that looks like data.
 */

import { inflateRawSync } from 'node:zlib';
import { MarketDataError } from '@tapedeck/core';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
/** The sentinel classic ZIP uses for a value that only fits in a ZIP64 extra field. */
const ZIP64_SENTINEL = 0xffffffff;

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly method: number;
  /** Offset of this entry's local file header. */
  readonly headerOffset: number;
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new MarketDataError(`zip: ${message}`, details);
}

/**
 * Finds the end-of-central-directory record.
 *
 * It sits at the very end unless the archive carries a comment, so the search runs backwards over
 * the last 64 KiB — the most a comment length field can express.
 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let at = buffer.length - 22; at >= earliest; at--) {
    if (buffer.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  return fail('no end-of-central-directory record; this is not a zip file');
}

/** Lists the entries of an archive. Reads the central directory only, never the payloads. */
export function readZipEntries(buffer: Buffer): readonly ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  if (diskNumber !== 0) fail('multi-disk archives are not supported', { diskNumber });
  if (directoryOffset === ZIP64_SENTINEL || count === 0xffff) {
    fail('ZIP64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== CENTRAL_FILE_HEADER) {
      fail('central directory is malformed', { entry: i, at });
    }
    const flags = buffer.readUInt16LE(at + 8);
    if ((flags & 0x1) !== 0) fail('encrypted entries are not supported', { entry: i });

    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const headerOffset = buffer.readUInt32LE(at + 42);
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      fail('ZIP64 sizes are not supported', { entry: i });
    }

    entries.push({
      name: buffer.toString('utf8', at + 46, at + 46 + nameLength),
      compressedSize,
      uncompressedSize,
      method,
      headerOffset,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The raw, still-compressed bytes of one entry, located through its local header. */
function payloadOf(buffer: Buffer, entry: ZipEntry): Buffer {
  const { headerOffset } = entry;
  if (buffer.readUInt32LE(headerOffset) !== LOCAL_FILE_HEADER) {
    fail('local file header is malformed', { name: entry.name, headerOffset });
  }
  const nameLength = buffer.readUInt16LE(headerOffset + 26);
  const extraLength = buffer.readUInt16LE(headerOffset + 28);
  const start = headerOffset + 30 + nameLength + extraLength;
  return buffer.subarray(start, start + entry.compressedSize);
}

/**
 * Decompresses one entry.
 *
 * B3's inner archives are a few hundred megabytes uncompressed, so this is the memory high-water
 * mark of a fetch. It is still the right trade: the alternative is a streaming inflate whose
 * consumer has to handle an XML element split across chunk boundaries, and the caller here scans
 * for elements anyway.
 */
export function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const payload = payloadOf(buffer, entry);
  if (entry.method === STORED) return Buffer.from(payload);
  if (entry.method !== DEFLATED) {
    fail(`compression method ${String(entry.method)} is not supported`, { name: entry.name });
  }
  return inflateRawSync(payload);
}

/** Finds one entry by name or by predicate, and decompresses it. */
export function extractFromZip(
  buffer: Buffer,
  match: string | ((entry: ZipEntry) => boolean),
): { readonly entry: ZipEntry; readonly contents: Buffer } {
  const entries = readZipEntries(buffer);
  const predicate = typeof match === 'string' ? (e: ZipEntry) => e.name === match : match;
  const entry = entries.find(predicate);
  if (entry === undefined) {
    fail('no entry matched', { available: entries.map((e) => e.name).slice(0, 20) });
  }
  return { entry, contents: readZipEntry(buffer, entry) };
}
