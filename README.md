# MAS-Runner（自动更新分发源）

媒体后台业务流程执行器。**声明式 spec 解释器**：业务逻辑全部写在 spec.json 里，
本脚本不含任何具体业务逻辑。

## 安装（只做一次）

1. 浏览器装 **Tampermonkey**（油猴）扩展；
2. 打开下面这个地址，油猴会弹出安装页，点「安装」：

   https://gitee.com/dahan_2014/mas-runner/raw/main/mas-runner.user.js

3. 之后**不需要再手动重装**：脚本头部声明了 `@updateURL`，油猴会定期自动检查并静默升级到新版本。

   安装/更新主源是 Gitee（国内直连稳定）；GitHub raw 与 jsDelivr 是镜像备份，
   面板「检查更新」会按 Gitee → GitHub → jsDelivr 顺序尝试：

   - 镜像 1（GitHub raw）：https://raw.githubusercontent.com/liuzheng2014/mas-runner/main/mas-runner.user.js
   - 镜像 2（jsDelivr）：https://cdn.jsdelivr.net/gh/liuzheng2014/mas-runner@main/mas-runner.user.js

## 确认版本 / 手动更新

在 ads.huawei.com 页面右下角悬浮球 → 展开面板 → 标题旁显示当前版本，
点「检查更新」可立即查询最新版本（发现新版会给更新链接）。

## 什么时候会更新

- 解释器能力升级（新增原语、修 bug、断言语法扩展）→ 需要新版本脚本；
- 业务流程变化（改参数、改步骤、改接口）→ **只是 spec 变更，脚本不用动、也不会更新**。

## 说明

本仓库只托管执行器代码，不包含任何 spec、接口证据或客户数据。
源码在私有仓库维护，本仓库由发布脚本自动同步。
