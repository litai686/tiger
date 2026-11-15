// 项目管理视图（hash 路由 #/projects）
// 布局：左栏项目列表 + 懒加载文件树，右侧预览文件内容；有 Git 变更的文件直接显示差异。
// 文件与 Git 数据全部走服务端 HTTP（agent_http_request）：桌面端可能连远程服务端。
import { applyToDOM } from "../i18n.js";
import { template } from "./projects/template.js";
import { state } from "./projects/store.js";
import * as store from "./projects/store.js";
import * as api from "./projects/api.js";
import * as ui from "./projects/ui.js";

export default {
  template,
  async mount(root) {
    root.innerHTML = template;
    applyToDOM(root);
    store.init(root);
    store.onRender(ui.render);
    ui.bind(root);
    ui.render();

    try {
      state.caps = await api.probeCapabilities();
    } catch (e) {
      if (state.destroyed) return;
      state.pageError = "未连接服务端";
      ui.render();
      return;
    }
    if (state.destroyed) return;
    if (!state.caps.files) {
      state.pageError = "服务端版本过低，请升级服务端后使用项目管理";
      ui.render();
      return;
    }
    ui.render();

    await store.loadProjects();
    if (state.destroyed) return;
    await store.selectInitialProject();
  },
  unmount() {
    ui.unbind();
    store.reset();
  },
};
