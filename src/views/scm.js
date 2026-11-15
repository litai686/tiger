// 源码管理视图（hash 路由 #/scm）
// 布局参考 VSCode 源代码管理：左栏仓库 / 提交框 / 更改 / 已暂存 / 提交图表，右侧差异。
// 文件与 Git 数据全部走服务端 HTTP（agent_http_request）：桌面端可能连远程服务端。
import { applyToDOM } from "../i18n.js";
import { template } from "./scm/template.js";
import { state } from "./scm/store.js";
import * as store from "./scm/store.js";
import * as api from "./scm/api.js";
import * as render from "./scm/render.js";
import * as ui from "./scm/ui.js";

export default {
  template,
  async mount(root) {
    root.innerHTML = template;
    applyToDOM(root);
    store.init(root);
    store.onRender(render.render);
    ui.bind(root);
    render.render();

    try {
      state.caps = await api.probeCapabilities();
    } catch (e) {
      if (state.destroyed) return;
      state.pageError = "未连接服务端";
      render.render();
      return;
    }
    if (state.destroyed) return;
    if (!state.caps.git) {
      state.pageError = "服务端版本过低，请升级服务端后使用源码管理";
      render.render();
      return;
    }
    render.render();

    await store.loadProjects();
    if (state.destroyed) return;
    await store.selectInitialProject();
  },
  unmount() {
    ui.unbind();
    store.reset();
  },
};
