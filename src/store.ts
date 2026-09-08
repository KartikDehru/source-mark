import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * A small JSON-file store. Deliberately boring: in SPLIT_MODE=ledger this is
 * the accounting of record, and it should be trivially auditable by opening the
 * file. SPLIT_MODE=onchain replaces it with SourcePayouts.sol.
 */

const DATA_DIR = resolve(process.cwd(), 'data');

function pathFor(name: string): string {
  return resolve(DATA_DIR, `${name}.json`);
}

export function readCollection<T>(name: string): T[] {
  const file = pathFor(name);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeCollection<T>(name: string, rows: T[]): void {
  const file = pathFor(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

export function appendTo<T>(name: string, row: T): void {
  const rows = readCollection<T>(name);
  rows.push(row);
  writeCollection(name, rows);
}
