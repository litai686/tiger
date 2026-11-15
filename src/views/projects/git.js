// 项目管理视图：Git 状态映射、徽标与目录聚合（纯函数）

export const PRIORITY = ["conflict", "deleted", "modified", "renamed", "added", "untracked"];

/**
 * @typedef {{path:string,index:string,worktree:string,untracked:boolean,orig_path:string}} StatusEntry
 */

/** @param {StatusEntry} e @returns {string} */
export function badgeOf(e) {
  const x = e.index;
  const y = e.worktree;
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflict";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R") return "renamed";
  if (x === "C" || x === "A") return "added";
  return "modified";
}

/** @param {StatusEntry} e */
export function hasStaged(e) {
  return e.index !== " " && e.index !== "?" && e.index !== "!";
}

/** 徽标展示字母（与颜色/优先级一一对应） */
export const BADGE_LABEL = {
  conflict: "C",
  deleted: "D",
  modified: "M",
  renamed: "R",
  added: "A",
  untracked: "U",
};

export function parentDir(p) {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? "" : p.substring(0, idx);
}

export function basename(p) {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.substring(idx + 1);
}

/**
 * 目录聚合：status 刷新时一次性预计算，渲染/展开时 O(1) 查表。
 * @param {Map<string, StatusEntry>} entries
 * @returns {Map<string,string>} relDir -> badge
 */
export function buildDirIndex(entries) {
  const idx = new Map();
  for (const [p, e] of entries) {
    const badge = badgeOf(e);
    let dir = parentDir(p);
    while (true) {
      const prev = idx.get(dir);
      if (!prev || PRIORITY.indexOf(badge) < PRIORITY.indexOf(prev)) idx.set(dir, badge);
      if (dir === "") break;
      dir = parentDir(dir);
    }
  }
  return idx;
}
