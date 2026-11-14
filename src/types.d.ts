// 全局类型声明 —— 仅供编辑器与 `pnpm typecheck`（tsc --noEmit）使用，不参与运行时。
// 前端不编译：这里只描述 index.html 暴露的全局与 Tauri IPC 的形状。

export {};

declare global {
  interface Window {
    /** Tauri invoke（index.html 初始化时暴露给所有视图模块） */
    __agent_invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
    /** Tauri event.listen（返回 unlisten 函数的 Promise） */
    __agent_listen: (event: string, handler: (event: { payload: any }) => void) => Promise<() => void>;
    /** 跨视图共享状态（agentBusy 等） */
    __agent_state: {
      agentBusy: boolean;
      [key: string]: any;
    };
    /** index.html 暴露的更新弹窗控制 + i18n */
    Agent: {
      showUpdateDialog: (html: string, owner?: string) => void;
      hideUpdateDialog: () => void;
      checkForUpdate: (silent?: boolean) => Promise<void>;
      /** 应用自升级：manual=true 时展示下载进度与「查看升级日志」入口 */
      startAppUpdate: (result: {
        has_update?: boolean;
        remote_version?: string;
        current_version?: string;
        download_url?: string;
        changelog_url?: string;
      }, opts?: { manual?: boolean }) => void;
      /** 当前升级状态（settings 版号面板用于提示「已下载，可升级」） */
      getAppUpdate: () => any;
      /** 升级日志按钮：地址由 update.json 的 content 字段下发，缺失时返回空串 */
      changelogButton: (url?: string) => string;
      openChangelog: () => void;
      /** 读取服务端硬件信息（CPU/内存/硬盘）并刷新底部状态栏；连接成功后可立即调用 */
      refreshSystemInfo: () => Promise<any>;
      i18n?: {
        t: (str: string) => string;
        tV: (str: string, vars?: Record<string, string | number>) => string;
        setLanguage: (l: string) => void;
        getLanguage: () => string;
        syncLanguageFromSettings: (settings: any) => void;
        applyToDOM: (root: any) => void;
      };
    };
    __TAURI__?: any;
    __TAURI_INTERNALS__?: any;
    goAgent: () => Promise<void>;
    openUrl: (url: string) => void;
  }
}
