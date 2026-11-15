// 项目管理视图：左栏上部的项目列表
import { t as _t } from "../../i18n.js";
import { state } from "./store.js";

function projectRow(project) {
  const row = document.createElement("div");
  row.className = "projects-project" + (project.path === state.activePath ? " active" : "");
  row.setAttribute("data-action", "select-project");
  row.setAttribute("data-path", project.path);
  row.title = project.path;

  const top = document.createElement("div");
  top.className = "projects-project-top";
  if (project.isDefault) {
    const star = document.createElement("span");
    star.className = "projects-project-star";
    star.textContent = "★";
    top.appendChild(star);
  }
  const name = document.createElement("span");
  name.className = "projects-project-name";
  name.textContent = project.name || project.path;
  top.appendChild(name);

  if (project.loadState === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "projects-spinner";
    top.appendChild(spinner);
  }
  row.appendChild(top);

  const path = document.createElement("div");
  path.className = "projects-project-path";
  path.textContent = project.path;
  row.appendChild(path);

  if (project.loadState === "error") {
    const err = document.createElement("div");
    err.className = "projects-project-status error";
    err.textContent = _t("加载项目失败: ") + (project.error || "");
    err.title = project.error || "";
    row.appendChild(err);
  } else if (project.source === "workspace" && project.loadState === "idle" && !project.wsId) {
    const hint = document.createElement("div");
    hint.className = "projects-project-status";
    hint.textContent = _t("需加载");
    row.appendChild(hint);
  }
  return row;
}

/** @param {HTMLElement} container */
export function renderProjectsList(container) {
  container.textContent = "";
  if (state.projectsLoading && state.projects.length === 0) {
    const loading = document.createElement("div");
    loading.className = "projects-placeholder";
    loading.textContent = _t("正在加载项目...");
    container.appendChild(loading);
    return;
  }
  if (state.projectsError && state.projects.length === 0) {
    const err = document.createElement("div");
    err.className = "projects-placeholder error";
    err.textContent = _t("加载项目失败: ") + state.projectsError;
    container.appendChild(err);
    return;
  }
  if (state.projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "projects-placeholder";
    empty.textContent = _t("还没有加载项目");
    const hint = document.createElement("div");
    hint.className = "projects-placeholder";
    hint.textContent = _t("请先在 Agent 页的工作目录下拉中添加项目目录");
    container.appendChild(empty);
    container.appendChild(hint);
    return;
  }

  const workdirs = state.projects.filter(function (p) {
    return p.source === "workdir";
  });
  const workspaces = state.projects.filter(function (p) {
    return p.source === "workspace";
  });
  if (workdirs.length) {
    const label = document.createElement("div");
    label.className = "projects-group-label";
    label.textContent = _t("工作目录");
    container.appendChild(label);
    for (const p of workdirs) container.appendChild(projectRow(p));
  }
  if (workspaces.length) {
    const label = document.createElement("div");
    label.className = "projects-group-label";
    label.textContent = _t("服务端工作区");
    container.appendChild(label);
    for (const p of workspaces) container.appendChild(projectRow(p));
  }
}
