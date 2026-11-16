// 终端视图（hash 路由 #/terminal）
// 服务端交互 PTY 会话 + Agent 后台作业的管理台：左侧列表，右侧 xterm 终端
// （SSE 增量 + POST 输入/尺寸）或后台作业输出。
import { applyToDOM } from "../i18n.js";
import { template } from "./terminal/template.js";
import * as store from "./terminal/store.js";
import * as render from "./terminal/render.js";
import * as ui from "./terminal/ui.js";

export default {
  template,
  async mount(root) {
    root.innerHTML = template;
    applyToDOM(root);
    store.init(root);
    store.onRender(render.render);
    ui.bind(root);
    render.resetCaches();
    render.render();
    await store.bootstrap();
  },
  unmount() {
    ui.unbind();
    store.reset();
  },
};
