export interface Column<T> {
  readonly header: string;
  readonly value: (row: T) => string;
}

/** Prints rows as an aligned table, or nothing but a note when the set is empty. */
export function printTable<T>(rows: ReadonlyArray<T>, columns: ReadonlyArray<Column<T>>, emptyMessage: string): void {
  if (rows.length === 0) {
    console.log(emptyMessage);
    return;
  }

  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, index) => Math.max(column.header.length, ...cells.map((rowCells) => rowCells[index].length)));

  // The final column is not padded, so copying a line does not pick up trailing spaces.
  const format = (values: ReadonlyArray<string>): string => values.map((value, index) => (index === values.length - 1 ? value : value.padEnd(widths[index]))).join('  ');

  console.log(format(columns.map((column) => column.header)));
  console.log(format(widths.map((width) => '-'.repeat(width))));
  for (const rowCells of cells) {
    console.log(format(rowCells));
  }
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function formatTimestamp(epochMs: number | undefined): string {
  if (epochMs === undefined) {
    return '-';
  }
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

/** A compact "3m ago" style age, which reads better than a timestamp in a list. */
export function formatAge(epochMs: number | undefined, now: number = Date.now()): string {
  if (epochMs === undefined) {
    return '-';
  }
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return '-';
  }
  if (ms % 86400_000 === 0) {
    return `${ms / 86400_000}d`;
  }
  if (ms % 3600_000 === 0) {
    return `${ms / 3600_000}h`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  if (ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  return `${ms}ms`;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
