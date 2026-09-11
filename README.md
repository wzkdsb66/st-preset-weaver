# Preset Weaver

一个面向 SillyTavern v1.18 的聊天补全预设管理器，由两部分组成：

- **UI Extension**：悬浮窗界面、预设切换、标签筛选、模块编辑和分组开关。
- **Server Plugin**：按 SillyTavern 用户隔离保存模块库、分组、使用记录和备份，并提供导入导出。

## 功能

- 聊天补全预设快速切换
- 多标签分类、按分类筛选、按最近使用排序
- 非 marker 提示词条目提取为全局模块
- 模块编辑、开启/关闭、分组开关
- 修改模块后选择同步到引用它的预设
- 覆盖、切换、恢复前自动备份
- 备份与插件数据导出导入
- 桌面/手机自适应悬浮窗
- 独立白天/夜间模式

## 安装 UI 扩展

1. 在 SillyTavern 的 **Manage Extensions** 中选择从 GitHub URL 安装本仓库。
2. 确认 SillyTavern 版本为 `1.18.0` 或更高。

## 安装 Server Plugin

1. 打开 SillyTavern 的 `config.yaml`，设置：

   ```yaml
   enableServerPlugins: true
   ```

2. 重启 SillyTavern。
3. 复制本仓库的 `server-plugin/` 目录到 SillyTavern：

   ```text
   <SillyTavern>/plugins/st-preset-weaver/
   ```

   目录内应包含 `index.cjs`。
4. 再次重启 SillyTavern。

Server Plugin 没有第三方 Node 依赖。

## 数据位置

插件数据保存在每个 SillyTavern 用户的目录中：

```text
<data>/<user-handle>/extensions-data/st-preset-weaver/
```

备份保存在其下的 `backups/` 目录。插件不会读写其他用户的数据。

## 使用

1. 点击右侧悬浮窗按钮。
2. 左侧浏览预设，右侧编辑当前选中的模块。
3. 在模块卡片上使用开关控制当前预设中的启用状态。
4. 编辑模块后，插件会列出引用它的预设，由你确认同步范围。

## 验收

本插件的目标验收包括：真实 SillyTavern v1.18 安装加载、预设切换、模块提取与开关、分组控制、备份恢复、导入导出、双端 UI、主题切换，以及两个账号的数据隔离。
