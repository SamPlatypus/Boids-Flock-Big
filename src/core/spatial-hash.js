/**
 * Toroidal uniform-grid spatial hash (a "bin lattice") for neighbour queries.
 *
 * Build: every step all points are binned with a two-pass counting sort into
 * flat typed arrays, O(N + C) for N points and C cells, with no per-step
 * allocation. `cellStart[c] .. cellStart[c + 1]` is the slice of `items` that
 * holds the point indices of cell c.
 *
 * Query: "all points within radius r, or the K nearest of them if there are
 * more than K" (K = the output buffer's capacity). Cells are visited in
 * square rings of increasing Chebyshev distance around the query cell, and the
 * K best are kept in a max-heap. After each ring, the distance from the query
 * point to the unvisited region is a lower bound on every remaining
 * candidate. Once the heap is full and its farthest member is within that
 * bound, the search stops. Per-query work is therefore bounded by the local
 * density only up to K neighbours: in a sparse area the query scans the few
 * cells within r, and inside a dense school it stops after the first ring or
 * two. N queries cost O(N·K), i.e. O(N), instead of the naive O(N²) and
 * without the density blow-up of a plain fixed-radius grid query.
 *
 * Exact tiling: the cell size is adjusted so cells tile the torus exactly
 * (cellWidth = W / cols). A cell index can then be wrapped with plain modular
 * arithmetic, and no cell straddles the seam.
 *
 * @module core/spatial-hash
 */

/** Smallest allowed cell edge, in world units, to bound the number of cells. */
const MIN_CELL_SIZE = 4;

/**
 * Reusable output buffer for neighbour queries. Each result stores the
 * neighbour index and the minimum-image displacement (neighbour − query point),
 * so callers never recompute the toroidal delta. Result order is unspecified.
 */
export class NeighborBuffer {
  /** @param {number} capacity Maximum neighbours kept per query (K). */
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;
    this.index = new Int32Array(capacity);
    this.dx = new Float64Array(capacity);
    this.dy = new Float64Array(capacity);
    this.distSq = new Float64Array(capacity);
  }
}

/**
 * Restore the max-heap property (by distSq) below slot `start`.
 * @param {NeighborBuffer} out
 * @param {number} start
 * @param {number} n Heap size.
 */
function siftDown(out, start, n) {
  const index = out.index;
  const dx = out.dx;
  const dy = out.dy;
  const d2 = out.distSq;
  const ti = index[start];
  const tdx = dx[start];
  const tdy = dy[start];
  const td2 = d2[start];
  let i = start;
  for (;;) {
    let child = 2 * i + 1;
    if (child >= n) break;
    if (child + 1 < n && d2[child + 1] > d2[child]) child++;
    if (d2[child] <= td2) break;
    index[i] = index[child];
    dx[i] = dx[child];
    dy[i] = dy[child];
    d2[i] = d2[child];
    i = child;
  }
  index[i] = ti;
  dx[i] = tdx;
  dy[i] = tdy;
  d2[i] = td2;
}

export class ToroidalSpatialHash {
  constructor() {
    this.width = 1;
    this.height = 1;
    this.cols = 1;
    this.rows = 1;
    this.cellWidth = 1;
    this.cellHeight = 1;
    this.invCellWidth = 1;
    this.invCellHeight = 1;
    this.invWidth = 1;
    this.invHeight = 1;
    this.cellStart = new Int32Array(2);
    this.cellCursor = new Int32Array(1);
    this.cellOfItem = new Int32Array(0);
    this.items = new Int32Array(0);
    /** @type {ArrayLike<number>} */
    this.xs = new Float64Array(0);
    /** @type {ArrayLike<number>} */
    this.ys = new Float64Array(0);
    this.count = 0;
    /** Points distance-tested since the counter was last reset (instrumentation). */
    this.candidatesChecked = 0;
  }

  /**
   * Set the world size and lattice resolution. Cheap; call every step.
   *
   * @param {number} width World width W > 0.
   * @param {number} height World height H > 0.
   * @param {number} targetCellSize Desired cell edge; adjusted to tile exactly.
   */
  configure(width, height, targetCellSize) {
    const size = Math.max(MIN_CELL_SIZE, targetCellSize);
    const cols = Math.max(1, Math.floor(width / size));
    const rows = Math.max(1, Math.floor(height / size));
    this.width = width;
    this.height = height;
    this.cols = cols;
    this.rows = rows;
    this.cellWidth = width / cols;
    this.cellHeight = height / rows;
    this.invCellWidth = cols / width;
    this.invCellHeight = rows / height;
    this.invWidth = 1 / width;
    this.invHeight = 1 / height;
    const cells = cols * rows;
    if (this.cellStart.length < cells + 1) {
      this.cellStart = new Int32Array(cells + 1);
      this.cellCursor = new Int32Array(cells);
    }
  }

  /**
   * Bin points with a counting sort. Coordinates must lie in [0, W) × [0, H)
   * (values that land exactly on W through rounding are clamped).
   *
   * @param {ArrayLike<number>} xs
   * @param {ArrayLike<number>} ys
   * @param {number} count Number of points (prefix of xs/ys).
   */
  build(xs, ys, count) {
    this.xs = xs;
    this.ys = ys;
    this.count = count;
    if (this.items.length < count) {
      const capacity = Math.max(64, 1 << Math.ceil(Math.log2(count)));
      this.items = new Int32Array(capacity);
      this.cellOfItem = new Int32Array(capacity);
    }
    const cols = this.cols;
    const rows = this.rows;
    const cells = cols * rows;
    const start = this.cellStart;
    const cursor = this.cellCursor;
    const cellOf = this.cellOfItem;
    const items = this.items;
    const icw = this.invCellWidth;
    const ich = this.invCellHeight;

    start.fill(0, 0, cells + 1);
    for (let i = 0; i < count; i++) {
      let cx = Math.floor(xs[i] * icw);
      let cy = Math.floor(ys[i] * ich);
      if (cx >= cols) cx = cols - 1;
      else if (cx < 0) cx = 0;
      if (cy >= rows) cy = rows - 1;
      else if (cy < 0) cy = 0;
      const cell = cy * cols + cx;
      cellOf[i] = cell;
      start[cell + 1]++;
    }
    // Exclusive prefix sum: start[c] = number of points in cells < c.
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    for (let c = 0; c < cells; c++) cursor[c] = start[c];
    // Ascending i keeps each cell's slice sorted, so results are deterministic.
    for (let i = 0; i < count; i++) items[cursor[cellOf[i]]++] = i;
  }

  /**
   * Find the points strictly within `radius` (toroidal distance) of (x, y),
   * or, if more than `out.capacity` qualify, exactly the `out.capacity` nearest.
   *
   * @param {number} x Query point (inside the world).
   * @param {number} y
   * @param {number} radius Query radius (> 0).
   * @param {number} exclude Point index to skip (the querying agent), or -1.
   * @param {NeighborBuffer} out Receives indices and displacements.
   * @returns {number} Number of neighbours written (also `out.count`).
   */
  query(x, y, radius, exclude, out) {
    const cols = this.cols;
    const rows = this.rows;
    const cw = this.cellWidth;
    const ch = this.cellHeight;
    const width = this.width;
    const height = this.height;
    const invW = this.invWidth;
    const invH = this.invHeight;
    const xs = this.xs;
    const ys = this.ys;
    const start = this.cellStart;
    const items = this.items;
    const outIndex = out.index;
    const outDx = out.dx;
    const outDy = out.dy;
    const outD2 = out.distSq;
    const capacity = out.capacity;
    const r2 = radius * radius;

    // Cell of the query point, and the cell range covering the query square in
    // unwrapped lattice coordinates.
    let ccx = Math.floor(x * this.invCellWidth);
    let ccy = Math.floor(y * this.invCellHeight);
    if (ccx >= cols) ccx = cols - 1;
    else if (ccx < 0) ccx = 0;
    if (ccy >= rows) ccy = rows - 1;
    else if (ccy < 0) ccy = 0;
    let cx0 = Math.floor((x - radius) * this.invCellWidth);
    let cx1 = Math.floor((x + radius) * this.invCellWidth);
    let cy0 = Math.floor((y - radius) * this.invCellHeight);
    let cy1 = Math.floor((y + radius) * this.invCellHeight);
    // If the range would cover an axis more than once, visit each column/row
    // exactly once instead (wrapping would otherwise duplicate points). Ring
    // order is then not distance order across the seam, so early exit is off.
    let ordered = true;
    if (cx1 - cx0 + 1 >= cols) {
      cx0 = 0;
      cx1 = cols - 1;
      ordered = false;
    }
    if (cy1 - cy0 + 1 >= rows) {
      cy0 = 0;
      cy1 = rows - 1;
      ordered = false;
    }
    const rings = Math.max(ccx - cx0, cx1 - ccx, ccy - cy0, cy1 - ccy);
    // Distances from the query point to the edges of its own cell.
    const left = x - ccx * cw;
    const right = cw - left;
    const top = y - ccy * ch;
    const bottom = ch - top;

    let n = 0;
    let checked = 0;

    for (let ring = 0; ring <= rings; ring++) {
      for (let cy = ccy - ring; cy <= ccy + ring; cy++) {
        if (cy < cy0 || cy > cy1) continue;
        let wy = cy % rows;
        if (wy < 0) wy += rows;
        const rowBase = wy * cols;
        // Full first/last row of the ring; only the two side cells in between.
        const stride = cy === ccy - ring || cy === ccy + ring ? 1 : 2 * ring;
        for (let cx = ccx - ring; cx <= ccx + ring; cx += stride) {
          if (cx < cx0 || cx > cx1) continue;
          let wx = cx % cols;
          if (wx < 0) wx += cols;
          const cell = rowBase + wx;
          const end = start[cell + 1];
          for (let p = start[cell]; p < end; p++) {
            const j = items[p];
            if (j === exclude) continue;
            checked++;
            // Minimum-image displacement: d − L·round(d / L).
            let dx = xs[j] - x;
            dx -= width * Math.round(dx * invW);
            let dy = ys[j] - y;
            dy -= height * Math.round(dy * invH);
            const d2 = dx * dx + dy * dy;
            if (d2 >= r2) continue;
            if (n < capacity) {
              outIndex[n] = j;
              outDx[n] = dx;
              outDy[n] = dy;
              outD2[n] = d2;
              n++;
              if (n === capacity) {
                for (let k = (capacity >> 1) - 1; k >= 0; k--) siftDown(out, k, capacity);
              }
            } else if (d2 < outD2[0]) {
              // Full: replace the farthest kept neighbour (the heap root).
              outIndex[0] = j;
              outDx[0] = dx;
              outDy[0] = dy;
              outD2[0] = d2;
              siftDown(out, 0, capacity);
            }
          }
        }
      }
      if (!ordered) continue;
      // Every unvisited candidate is at least `bound` away.
      const bound = Math.min(left + ring * cw, right + ring * cw, top + ring * ch, bottom + ring * ch);
      if (bound >= radius) break; // nothing further can be within the radius
      if (n === capacity && outD2[0] <= bound * bound) break; // the K nearest are final
    }

    this.candidatesChecked += checked;
    out.count = n;
    return n;
  }
}
