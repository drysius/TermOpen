import type { WorkspaceBlockLayout } from "@/components/workspace/workspace-block-controller";

type WorkspaceKind = "terminal" | "sftp" | "rdp" | "editor";

export function snapLayoutToWorkspace(
  layout: WorkspaceBlockLayout,
  workspace: { width: number; height: number },
): WorkspaceBlockLayout {
  const gap = 8;
  const threshold = 32;
  const maxX = Math.max(gap, workspace.width - layout.width - gap);
  const maxY = Math.max(gap, workspace.height - layout.height - gap);
  const x = Math.max(gap, Math.min(layout.x, maxX));
  const y = Math.max(gap, Math.min(layout.y, maxY));
  const nearLeft = x <= threshold;
  const nearTop = y <= threshold;
  const nearRight = x + layout.width >= workspace.width - threshold;
  const nearBottom = y + layout.height >= workspace.height - threshold;

  const halfWidth = Math.max(320, Math.floor((workspace.width - gap * 3) / 2));
  const halfHeight = Math.max(220, Math.floor((workspace.height - gap * 3) / 2));
  const fullWidth = Math.max(320, workspace.width - gap * 2);
  const fullHeight = Math.max(220, workspace.height - gap * 2);

  if (nearLeft && nearTop) {
    return { x: gap, y: gap, width: halfWidth, height: halfHeight };
  }
  if (nearRight && nearTop) {
    return { x: workspace.width - gap - halfWidth, y: gap, width: halfWidth, height: halfHeight };
  }
  if (nearLeft && nearBottom) {
    return { x: gap, y: workspace.height - gap - halfHeight, width: halfWidth, height: halfHeight };
  }
  if (nearRight && nearBottom) {
    return {
      x: workspace.width - gap - halfWidth,
      y: workspace.height - gap - halfHeight,
      width: halfWidth,
      height: halfHeight,
    };
  }
  if (nearLeft) {
    return { x: gap, y: gap, width: halfWidth, height: fullHeight };
  }
  if (nearRight) {
    return { x: workspace.width - gap - halfWidth, y: gap, width: halfWidth, height: fullHeight };
  }
  if (nearTop) {
    return { x: gap, y: gap, width: fullWidth, height: halfHeight };
  }
  if (nearBottom) {
    return { x: gap, y: workspace.height - gap - halfHeight, width: fullWidth, height: halfHeight };
  }

  return { ...layout, x, y };
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
