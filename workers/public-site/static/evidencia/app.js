/**
 * app.js for /evidencia/
 * Fetch and render hit rates data.
 */

/**
 * Builds table rows for the given cells.
 * Returns an array of DOM Elements (TRs).
 * @param {Array<Object>} cells
 * @returns {Array<HTMLElement>}
 */
export function renderRows(cells) {
  if (!cells || cells.length === 0) {
    return [];
  }

  const rows = [];
  for (const cell of cells) {
    const tr = document.createElement('tr');

    const cols = ['kind', 'tf', 'symbol', 'direction', 'n', 'tasa_1r', 'interval', 'break_even', 'baseline', 'grade'];

    // Create elements and text content for each
    for (const col of cols) {
      const td = document.createElement('td');

      let text = cell[col] !== undefined ? String(cell[col]) : '';

      if (col === 'tasa_1r' && cell.n !== undefined && cell.n < 30) {
        text = 'sin evidencia';
      }

      td.textContent = text;
      tr.appendChild(td);
    }

    rows.push(tr);
  }

  return rows;
}

export async function init() {
  const tbody = document.getElementById('table-body');
  const tableState = document.getElementById('table-state');

  if (!tbody || !tableState) return;

  try {
    const res = await fetch('/api/hit-rates');
    if (!res.ok) throw new Error('fetch error');

    const data = await res.json();
    const cells = data.cells || [];

    if (cells.length === 0) {
      tableState.textContent = 'Aún no hay datos publicados.';
    } else {
      tableState.textContent = ''; // clear any loading msg
      const rows = renderRows(cells);
      for (const row of rows) {
        tbody.appendChild(row);
      }
    }
  } catch (err) {
    tableState.textContent = 'Error al cargar los datos.';
    console.error(err);
  }
}

// Call init on load
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
