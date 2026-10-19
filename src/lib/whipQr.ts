import { encode } from '@verevoir/qr';

export const WHIP_QR_COLORS = Object.freeze({
  background: '#0a0a0f',
  cyan: '#00f0ff',
  purple: '#b967ff',
  pink: '#ff4d9e',
});

export const WHIP_QR_EXPORT_SIZE = 512;
const QUIET_MODULES = 5;
const FINDER_SIZE = 7;
const ALIGNMENT_SIZE = 5;
const LOGO_RATIO = 0.2;
const LOGO_MARGIN = 0.5;
const LOGO_RESERVATIONS = [0.06, 0.15, 0.3, 0.5, 0.65, 0.8] as const;
const GRADIENT_ID = 'whip-qr-neon';
const GRADIENT_FILL = `url(#${GRADIENT_ID})`;
const NEIGHBORS = [
  [1, -1],
  [1, 1],
  [1, 0],
  [-1, 1],
  [0, 1],
  [-1, -1],
  [-1, 0],
  [0, -1],
] as const;

interface Point {
  x: number;
  y: number;
}

function circuitTraces(matrix: Uint8Array[]): string {
  const size = matrix.length;
  const visited = new Uint8Array(size * size);
  const artwork: string[] = [];
  const circle = ({ x, y }: Point) =>
    `<circle cx="${x + 1.5}" cy="${y + 1.5}" r="0.6" fill="${GRADIENT_FILL}"/>`;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!matrix[y][x] || visited[y * size + x]) continue;
      const start = { x, y };
      visited[y * size + x] = 1;
      const path: Point[] = [start];
      const stack = [{ point: start, neighbor: 0 }];
      // An explicit walk stack keeps dense RSA codes within the JS stack limit.
      while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.neighbor === NEIGHBORS.length) {
          stack.pop();
          const parent = stack[stack.length - 1];
          if (parent) path.push(parent.point);
          continue;
        }
        const [dx, dy] = NEIGHBORS[frame.neighbor++];
        const next = { x: frame.point.x + dx, y: frame.point.y + dy };
        if (
          next.x < 0 ||
          next.y < 0 ||
          next.x >= size ||
          next.y >= size ||
          !matrix[next.y][next.x]
        )
          continue;
        if (next.x === start.x && next.y === start.y) break;
        const index = next.y * size + next.x;
        if (visited[index]) continue;
        visited[index] = 1;
        path.push(next);
        stack.push({ point: next, neighbor: 0 });
      }
      if (path.length === 1) {
        artwork.push(circle(start));
        continue;
      }
      path.push(start);
      const vertices = path.filter((point, index) => {
        if (!index || index === path.length - 1) return true;
        const before = path[index - 1];
        const after = path[index + 1];
        return (
          point.x - before.x !== after.x - point.x ||
          point.y - before.y !== after.y - point.y
        );
      });
      const drawing = vertices
        .map(
          (point, index) =>
            `${index ? 'L' : 'M'}${point.x + 1.5},${point.y + 1.5}`,
        )
        .join('');
      artwork.push(
        `<path d="${drawing}Z" stroke="${GRADIENT_FILL}" stroke-width="0.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
      const dots = new Map<string, Point>([[`${start.x},${start.y}`, start]]);
      vertices.forEach((point, index) => {
        const before =
          vertices[(index - 1 + vertices.length) % vertices.length];
        const after = vertices[(index + 1) % vertices.length];
        if (before.x === after.x && before.y === after.y)
          dots.set(`${point.x},${point.y}`, point);
      });
      artwork.push(...Array.from(dots.values(), circle));
    }
  }
  return artwork.join('');
}

export interface WhipQrImage {
  size: number;
  svg: string;
  logo: { x: number; y: number; size: number };
}

function logoPlacement(
  size: number,
  alignmentCoordinates: readonly (readonly [number, number])[],
) {
  for (
    let logoSize = size * LOGO_RATIO;
    logoSize >= (size * LOGO_RATIO) / 2;
    logoSize -= 1
  ) {
    const center = (size - logoSize) / 2;
    const overlaps = alignmentCoordinates.some(
      ([row, column]) =>
        center - LOGO_MARGIN < column + ALIGNMENT_SIZE &&
        center + logoSize + LOGO_MARGIN > column &&
        center - LOGO_MARGIN < row + ALIGNMENT_SIZE &&
        center + logoSize + LOGO_MARGIN > row,
    );
    if (!overlaps)
      return {
        x: center + QUIET_MODULES,
        y: center + QUIET_MODULES,
        size: logoSize,
      };
  }
  return null;
}

function encodeWithCenteredLogo(payload: string) {
  // A larger symbol can move alignment markers clear of the center. Reserve
  // more capacity until the logo fits there, keeping H-level correction.
  for (const logoArea of LOGO_RESERVATIONS) {
    const [qr] = encode(payload, { minErrorLevel: 'H', logoArea });
    if (!qr) break;
    const logo = logoPlacement(qr.size, qr.alignmentCoordinates);
    if (logo) return { qr, logo };
  }
  throw new Error('This QR code has no clear area for a centered Whip logo');
}

function marker(x: number, y: number, size: number): string {
  const finder = size === FINDER_SIZE;
  const outer = finder ? WHIP_QR_COLORS.cyan : GRADIENT_FILL;
  const center = finder ? WHIP_QR_COLORS.pink : GRADIENT_FILL;
  return (
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${finder ? 2 : size / 3}" fill="${outer}"/>` +
    `<rect x="${x + 1}" y="${y + 1}" width="${size - 2}" height="${size - 2}" rx="${finder ? 1.25 : 1}" fill="${WHIP_QR_COLORS.background}"/>` +
    `<rect x="${x + 2}" y="${y + 2}" width="${size - 4}" height="${size - 4}" rx="${finder ? 1 : 1 / 3}" fill="${center}"/>`
  );
}

/** Shared circuit artwork for the download QR and public-key sharing. */
export function whipQrImage(payload: string): WhipQrImage {
  const { qr, logo } = encodeWithCenteredLogo(payload);
  const matrix = qr.matrix.map(row => row.slice());
  const markers: string[] = [];
  const reserveMarker = (
    [row, column]: readonly [number, number],
    size: number,
  ) => {
    for (let y = row; y < row + size; y += 1) {
      matrix[y].fill(0, column, column + size);
    }
    markers.push(marker(column + 1, row + 1, size));
  };
  qr.finderCoordinates.forEach(position =>
    reserveMarker(position, FINDER_SIZE),
  );
  qr.alignmentCoordinates.forEach(position =>
    reserveMarker(position, ALIGNMENT_SIZE),
  );

  const traces = circuitTraces(matrix);
  const size = qr.size + QUIET_MODULES * 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WHIP_QR_EXPORT_SIZE}" height="${WHIP_QR_EXPORT_SIZE}" viewBox="0 0 ${size} ${size}">` +
    `<defs><linearGradient id="${GRADIENT_ID}" gradientUnits="userSpaceOnUse" x1="1" y1="1" x2="${qr.size + 1}" y2="${qr.size + 1}">` +
    `<stop offset="0" stop-color="${WHIP_QR_COLORS.cyan}"/><stop offset="1" stop-color="${WHIP_QR_COLORS.purple}"/></linearGradient>` +
    '<filter id="whip-qr-glow"><feGaussianBlur stdDeviation="0.12" result="glow"/><feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
    `<rect width="${size}" height="${size}" rx="3" fill="${WHIP_QR_COLORS.background}"/>` +
    `<g transform="translate(${QUIET_MODULES - 1} ${QUIET_MODULES - 1})" filter="url(#whip-qr-glow)">${traces}${markers.join('')}</g>` +
    `<rect x="${logo.x - LOGO_MARGIN}" y="${logo.y - LOGO_MARGIN}" width="${logo.size + LOGO_MARGIN * 2}" height="${logo.size + LOGO_MARGIN * 2}" rx="1" fill="#ffffff"/>` +
    '</svg>';
  return { size, svg, logo };
}
