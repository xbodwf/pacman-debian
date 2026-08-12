import { terminalWidth } from './progress';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleWidth(s: string): number {
  return terminalWidth(s.replace(ANSI_RE, ''));
}

/** Right-aligned column flag, matching pacman's CELL_RIGHT_ALIGN */
export interface TableColumn {
  title: string;
  right?: boolean;
}

interface Cell {
  text: string;
  right: boolean;
  empty: boolean;
}

/**
 * Render a table like pacman's table_display: column widths are the max of the
 * header and all row cells (multibyte-aware), columns are separated by 2
 * spaces, and right-aligned columns pad to their column width.
 */
export function renderTable(columns: TableColumn[], rows: string[][]): string {
  const ncols = columns.length;
  const cells: Cell[][] = rows.map(row => {
    const out: Cell[] = [];
    for (let c = 0; c < ncols; c++) {
      const text = row[c] ?? '';
      out.push({ text, right: !!columns[c].right, empty: text.length === 0 });
    }
    return out;
  });

  const widths: number[] = columns.map((col, c) => {
    const head = visibleWidth(col.title);
    let w = head;
    for (const row of cells) {
      const v = visibleWidth(row[c].text);
      if (v > w) w = v;
    }
    return w;
  });

  const lines: string[] = [];
  const fmt = (cell: Cell, c: number) => {
    const pad = widths[c] - visibleWidth(cell.text);
    return cell.right ? ' '.repeat(pad) + cell.text : cell.text + ' '.repeat(pad);
  };

  const headerLine = columns.map((col, c) => fmt({ text: col.title, right: false, empty: false }, c)).join('  ');
  lines.push(headerLine);

  for (const row of cells) {
    lines.push(row.map((cell, c) => fmt(cell, c)).join('  '));
  }
  return lines.join('\n');
}
