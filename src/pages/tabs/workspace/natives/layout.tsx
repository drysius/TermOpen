import type { WorkspaceBlockLayout } from "@/components/workspace/workspace-block-controller";

type WorkspaceKind = "terminal" | "sftp" | "rdp" | "editor";

type EdgeFlags = {
  left: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
};

type SnapLayoutOptions = {
  occupied?: WorkspaceBlockLayout[];
  minWidth?: number;
  minHeight?: number;
  maxDepth?: number;
  edgeTolerance?: number;
};

const DEFAULT_EDGE_TOLERANCE = 1;
const DEFAULT_MAX_DEPTH = 3;

function rectArea(rect: WorkspaceBlockLayout): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function overlapArea(left: WorkspaceBlockLayout, right: WorkspaceBlockLayout): number {
  const overlapWidth = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const overlapHeight = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) {
    return 0;
  }
  return overlapWidth * overlapHeight;
}

function buildEdgeFlags(
  layout: WorkspaceBlockLayout,
  workspace: { width: number; height: number },
  edgeTolerance: number,
): EdgeFlags {
  return {
    left: layout.x <= edgeTolerance,
    top: layout.y <= edgeTolerance,
    right: layout.x + layout.width >= workspace.width - edgeTolerance,
    bottom: layout.y + layout.height >= workspace.height - edgeTolerance,
  };
}

function hasAnyEdge(flags: EdgeFlags): boolean {
  return flags.left || flags.top || flags.right || flags.bottom;
}

function splitRectIntoCorners(rect: WorkspaceBlockLayout): WorkspaceBlockLayout[] {
  const leftWidth = Math.floor(rect.width / 2);
  const rightWidth = rect.width - leftWidth;
  const topHeight = Math.floor(rect.height / 2);
  const bottomHeight = rect.height - topHeight;

  return [
    { x: rect.x, y: rect.y, width: leftWidth, height: topHeight },
    { x: rect.x + leftWidth, y: rect.y, width: rightWidth, height: topHeight },
    { x: rect.x, y: rect.y + topHeight, width: leftWidth, height: bottomHeight },
    { x: rect.x + leftWidth, y: rect.y + topHeight, width: rightWidth, height: bottomHeight },
  ];
}

function collectCornerGridCells(
  rect: WorkspaceBlockLayout,
  minWidth: number,
  minHeight: number,
  maxDepth: number,
  acc: WorkspaceBlockLayout[],
  depth = 1,
): void {
  if (depth > maxDepth) {
    return;
  }

  const next = splitRectIntoCorners(rect).filter((cell) => cell.width >= minWidth && cell.height >= minHeight);
  for (const cell of next) {
    acc.push(cell);
    if (depth < maxDepth && cell.width >= minWidth * 2 && cell.height >= minHeight * 2) {
      collectCornerGridCells(cell, minWidth, minHeight, maxDepth, acc, depth + 1);
    }
  }
}

function touchesRequiredEdges(
  cell: WorkspaceBlockLayout,
  edges: EdgeFlags,
  workspace: { width: number; height: number },
  edgeTolerance: number,
): boolean {
  const cellEdges = buildEdgeFlags(cell, workspace, edgeTolerance);
  if (edges.left && !cellEdges.left) {
    return false;
  }
  if (edges.top && !cellEdges.top) {
    return false;
  }
  if (edges.right && !cellEdges.right) {
    return false;
  }
  if (edges.bottom && !cellEdges.bottom) {
    return false;
  }
  return true;
}

function containsPoint(layout: WorkspaceBlockLayout, x: number, y: number): boolean {
  return x >= layout.x && x <= layout.x + layout.width && y >= layout.y && y <= layout.y + layout.height;
}

function centerDistance(left: WorkspaceBlockLayout, right: WorkspaceBlockLayout): number {
  const leftCenterX = left.x + left.width / 2;
  const leftCenterY = left.y + left.height / 2;
  const rightCenterX = right.x + right.width / 2;
  const rightCenterY = right.y + right.height / 2;
  return Math.hypot(leftCenterX - rightCenterX, leftCenterY - rightCenterY);
}

function isCellAvailable(cell: WorkspaceBlockLayout, occupied: WorkspaceBlockLayout[]): boolean {
  return occupied.every((block) => overlapArea(cell, block) <= 1);
}

export function clampLayoutToWorkspace(
  layout: WorkspaceBlockLayout,
  workspace: { width: number; height: number },
): WorkspaceBlockLayout {
  const maxX = Math.max(0, workspace.width - layout.width);
  const maxY = Math.max(0, workspace.height - layout.height);
  return {
    ...layout,
    x: Math.max(0, Math.min(layout.x, maxX)),
    y: Math.max(0, Math.min(layout.y, maxY)),
  };
}

export function snapLayoutToWorkspace(
  layout: WorkspaceBlockLayout,
  workspace: { width: number; height: number },
  options: SnapLayoutOptions = {},
): WorkspaceBlockLayout {
  const minWidth = Math.max(1, Math.floor(options.minWidth ?? 320));
  const minHeight = Math.max(1, Math.floor(options.minHeight ?? 220));
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH));
  const edgeTolerance = Math.max(0, options.edgeTolerance ?? DEFAULT_EDGE_TOLERANCE);
  const occupied = Array.isArray(options.occupied) ? options.occupied : [];
  const clamped = clampLayoutToWorkspace(layout, workspace);
  const touchedEdges = buildEdgeFlags(clamped, workspace, edgeTolerance);

  if (!hasAnyEdge(touchedEdges)) {
    return clamped;
  }

  const root: WorkspaceBlockLayout = {
    x: 0,
    y: 0,
    width: workspace.width,
    height: workspace.height,
  };
  const cells: WorkspaceBlockLayout[] = [];
  collectCornerGridCells(root, minWidth, minHeight, maxDepth, cells);

  const centerX = clamped.x + clamped.width / 2;
  const centerY = clamped.y + clamped.height / 2;
  const candidates = cells
    .filter((cell) => touchesRequiredEdges(cell, touchedEdges, workspace, edgeTolerance))
    .filter((cell) => isCellAvailable(cell, occupied));

  if (candidates.length === 0) {
    return clamped;
  }

  const targetPointRect: WorkspaceBlockLayout = { x: centerX, y: centerY, width: 0, height: 0 };
  const sorted = [...candidates].sort((left, right) => {
    const leftContainsCenter = containsPoint(left, centerX, centerY);
    const rightContainsCenter = containsPoint(right, centerX, centerY);
    if (leftContainsCenter !== rightContainsCenter) {
      return leftContainsCenter ? -1 : 1;
    }

    const areaDiff = rectArea(left) - rectArea(right);
    if (areaDiff !== 0) {
      return areaDiff;
    }

    return centerDistance(left, targetPointRect) - centerDistance(right, targetPointRect);
  });

  return sorted[0] ?? clamped;
}

export function workspaceDefaultLayout(
  kind: WorkspaceKind,
  index: number,
  workspaceWidth: number,
  workspaceHeight: number,
): WorkspaceBlockLayout {
  const safeWidth = Math.max(900, workspaceWidth);
  const safeHeight = Math.max(560, workspaceHeight);
  if (kind === "sftp" && index === 0) {
    return {
      x: 8,
      y: 8,
      width: Math.floor(safeWidth * 0.3) - 12,
      height: safeHeight - 16,
    };
  }
  if (kind === "terminal" && index === 1) {
    const leftWidth = Math.floor(safeWidth * 0.3);
    return {
      x: leftWidth + 4,
      y: 8,
      width: safeWidth - leftWidth - 12,
      height: safeHeight - 16,
    };
  }
  if (kind === "rdp" && index === 0) {
    return {
      x: 8,
      y: 8,
      width: safeWidth - 16,
      height: safeHeight - 16,
    };
  }
  const span = 28 * index;
  return {
    x: 24 + span,
    y: 24 + span,
    width: Math.max(400, Math.floor(safeWidth * 0.56)),
    height: Math.max(280, Math.floor(safeHeight * 0.52)),
  };
}
