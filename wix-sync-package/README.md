# Wix IDE Sync

本地 VSCode ↔ Wix 在线 IDE 的实时同步工具。通过油猴脚本 + Node.js 服务，把本地代码映射到 Wix Velo 在线编辑器。

## 解决的问题

Wix Studio 的在线 JS 编辑器（Velo）没有代码补全、没有 lint、写复杂业务逻辑寸步难行。这个工具让你在本地 VSCode或者其他ide写代码，一键推到在线 IDE。每次推送前自动备份在线版本，出问题随时回滚。

## 架构

```
VSCode 本地文件改动
  → chokidar 检测 # sync-server.js
  → WebSocket 推送 file_changed # ws://127.0.0.1:9876
  → 油猴脚本接收，面板提示 "Changes pending" # 外层页面
  → 用户点击 Sync Now
  → postMessage 通知 iframe 执行 selectAll + copy # 备份在线代码
  → postMessage 通知 iframe 执行 selectAll + paste # 覆盖本地代码
  → 面板更新 "Synced ✓"
```

编辑器的读写走 VS Code 命令系统（`commands.executeCommand`），因为 Wix 把 Monaco editor model 锁在混淆后的 iframe 里，直接拿不到。

## 功能

- 半自动同步：文件变更后手动点按钮同步
- 同步前强制备份：备份失败就中止，不碰在线代码
- 一键恢复最新备份
- 错误日志（`logs/sync-errors.log`）
- 剪贴板保护：同步前后保存/恢复原始内容
- 中文文件名自动解码匹配

## 部署

**前置**: Node.js ≥ 16, Tampermonkey 浏览器扩展

```bash
git clone <repo-url> && cd wix-sync
npm install
node sync-server.js   # Windows: 双击 start-sync.bat
```

油猴脚本：把 `wix-sync.user.js` 装到 Tampermonkey。

## 使用

把 Wix Velo 页面代码的 `.js` 文件放到项目根目录（或用 `SYNC_DIR` 环境变量指向其他目录）。打开 Wix IDE 进入代码编辑器，右上角出现面板：

1. 下拉框选择要映射的本地文件
2. 在 VSCode 中编辑并保存
3. 面板出现 "Changes pending" 后点 **Sync Now**
4. 确认 → 自动备份 → 同步完成

恢复：面板底部 **Restore Last Backup**。备份文件在 `backups/` 目录。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SYNC_PORT` | `9876` | WebSocket 端口 |
| `SYNC_DIR` | 项目根目录 | 监听的 .js 文件目录 |

## 安全

- WS 绑定 `127.0.0.1`，不暴露到局域网
- 每次 Sync / Restore 有确认对话框
- 备份失败则同步中止，不修改在线代码
- 油猴脚本 `@grant none`，不申请 GM_ 特权
- 无认证——依赖 localhost 隔离。在多人共用机器上注意

## 限制

- 只同步 `.js`
- 全量替换，不做 diff
- 依赖 Wix 的 VS Code 模块路径不发生变化
- 剪贴板读写依赖浏览器权限

## 目录结构

```
├── sync-server.js
├── wix-sync.user.js
├── package.json
├── start-sync.bat
├── .gitignore
├── backups/        # 运行时生成
└── logs/           # 运行时生成
```

## License

MIT
