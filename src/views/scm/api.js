// 源码管理视图：复用项目管理视图的 HTTP 封装（agent_http_request / 单飞 GET / 错误归类 / 能力探测）。
// 两个视图连的是同一台服务端，错误文本与 URL 编码口径必须一致，避免各自维护一套出现漂移。
export {
  api,
  invokeCmd,
  get,
  qs,
  httpStatus,
  errorMessage,
  probeCapabilities,
} from "../projects/api.js";
