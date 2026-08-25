/**
 * Filesystem access for `.tape` files, kept separate from the format itself so that the encoder
 * and decoder stay pure and testable against byte arrays alone.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { BarChunk, InstrumentId, TickChunk } from '@tapedeck/core';
import {
  type EncodeBarsOptions,
  type EncodeTicksOptions,
  type TapeFile,
  decodeBarTape,
  decodeTickTape,
  encodeBarTape,
  encodeTickTape,
} from './tape-format.ts';

export function writeBarTapeFileSync(path: string, options: EncodeBarsOptions): void {
  writeFileSync(path, encodeBarTape(options));
}

export async function writeBarTapeFile(path: string, options: EncodeBarsOptions): Promise<void> {
  await writeFile(path, encodeBarTape(options));
}

export function readBarTapeFileSync(path: string, instrumentId?: InstrumentId): TapeFile<BarChunk> {
  return decodeBarTape(readFileSync(path), instrumentId);
}

export async function readBarTapeFile(
  path: string,
  instrumentId?: InstrumentId,
): Promise<TapeFile<BarChunk>> {
  return decodeBarTape(await readFile(path), instrumentId);
}

export async function writeTickTapeFile(path: string, options: EncodeTicksOptions): Promise<void> {
  await writeFile(path, encodeTickTape(options));
}

export async function readTickTapeFile(
  path: string,
  instrumentId?: InstrumentId,
): Promise<TapeFile<TickChunk>> {
  return decodeTickTape(await readFile(path), instrumentId);
}
