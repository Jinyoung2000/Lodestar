export type Corner = 0 | 1 | 2;
export type PieceCorners = { startTop: Corner; startBottom: Corner; endTop: Corner; endBottom: Corner };
export type PieceSpan = { left: number; right: number };

export function pieceCorners(pieces: readonly PieceSpan[], charWidth: number): PieceCorners[] {
  const tolerance = charWidth / 4;
  return pieces.map((piece, i) => {
    const corners: PieceCorners = { startTop: 0, startBottom: 0, endTop: 0, endBottom: 0 };
    const p = piece.left;
    const m = piece.right;
    const above = pieces[i - 1];
    if (above) {
      const v = above.left;
      const b = above.right;
      corners.startTop = Math.abs(p - v) < tolerance ? 2 : p > v ? 1 : 0;
      corners.endTop = Math.abs(m - b) < tolerance ? 2 : v < m && m < b ? 1 : 0;
    }
    const below = pieces[i + 1];
    if (below) {
      const v = below.left;
      const b = below.right;
      corners.startBottom = Math.abs(p - v) < tolerance ? 2 : v < p && p < b ? 1 : 0;
      corners.endBottom = Math.abs(m - b) < tolerance ? 2 : m < b ? 1 : 0;
    }
    return corners;
  });
}

export function radiusClasses(corners: PieceCorners): string[] {
  const classes: string[] = [];
  if (corners.startTop === 0) classes.push("cm-sel-top-left");
  if (corners.startBottom === 0) classes.push("cm-sel-bottom-left");
  if (corners.endTop === 0) classes.push("cm-sel-top-right");
  if (corners.endBottom === 0) classes.push("cm-sel-bottom-right");
  return classes;
}

export type FilletPiece = { side: "start" | "end"; radius: string[] };

export function filletPieces(corners: PieceCorners): FilletPiece[] {
  const pieces: FilletPiece[] = [];
  if (corners.startTop === 1 || corners.startBottom === 1) {
    const radius: string[] = [];
    if (corners.startTop === 1) radius.push("cm-sel-top-right");
    if (corners.startBottom === 1) radius.push("cm-sel-bottom-right");
    pieces.push({ side: "start", radius });
  }
  if (corners.endTop === 1 || corners.endBottom === 1) {
    const radius: string[] = [];
    if (corners.endTop === 1) radius.push("cm-sel-top-left");
    if (corners.endBottom === 1) radius.push("cm-sel-bottom-left");
    pieces.push({ side: "end", radius });
  }
  return pieces;
}
