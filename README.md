# Phone Executor — 云端手机执行器

通过云 Gateway 远程控制 Android 手机执行自动化任务。手机不需要公网 IP，由手机主动轮询 Gateway 获取指令。

```text
Hermes → Gateway → 手机轮询 → 手机执行 → Gateway 存结果 → Hermes 读取
```

## 快速开始

```bash
git clone https://github.com/qingci2014/phone-executor.git
cd phone-executor/gateway
cp config.example.json config.json
# 生成两个随机 token，分别给 Hermes 和手机使用
export PHONE_EXECUTOR_CLIENT_TOKEN="your-hermes-token-here"
export PHONE_EXECUTOR_DEVICE_TOKEN="your-phone-token-here"
node server.mjs
```

详细 API 文档见 [gateway/README.md](gateway/README.md)。

## 手机端配置

1. 安装 NeuralBridge APK
2. 打开 App → Setup 页面，授予所有权限（AccessibilityService、Notification Listener 等）
3. 在 Status 页面填入 Gateway 地址和设备 Token

## 息屏保持在线

Android 息屏后系统会限制后台应用，导致手机断连。以下是两种经过实机验证的解决方案：

### 方案一：系统权限全开（推荐）

在荣耀 / Android 手机上进行以下设置：

1. **应用权限**：设置 → 应用 → 应用管理 → NeuralBridge → 权限 → 所有权限全部允许
2. **通知权限**：设置 → 应用 → 应用管理 → NeuralBridge → 通知管理 → 允许通知
3. **应用启动管理**：设置 → 应用 → 应用启动管理 → 找到 NeuralBridge → 关闭「自动管理」→ 三项全部开启（自启动、关联启动、后台活动）
4. **电池优化**：设置 → 应用 → 特殊访问权限 → 电池优化 → 找到 NeuralBridge → 选择「不允许」
5. **开发者选项**：设置 → 系统和更新 → 开发者选项 → 关闭「不锁定屏幕」（即允许息屏不锁定）
   - 如果没开启开发者选项：设置 → 关于手机 → 连续点击「版本号」7 次

做完上述设置后，手机息屏状态下仍能保持 Gateway 连接和任务执行。

### 方案二：一直插着电

连接充电器保持手机供电。Android 在充电状态下对后台应用的限制会放宽，NeuralBridge 的前台服务更容易存活。

## 已验证设备

| 设备 | 型号 | Android 版本 | 状态 |
|------|------|-------------|------|
| HONOR X50 | ALI-AN00 | 15（SDK 35） | ✅ 已实机验证 |

## 项目结构

```
gateway/           # Node.js Gateway 服务（Hermes 和手机共用的云端中转）
  server.mjs       # 主服务入口
  config.example.json  # 配置模板（不含真实密钥）
  README.md        # Gateway API 详细文档
  systemd/         # Linux systemd 服务模板
scripts/           # 运维脚本（phone_execute.py 等）
patches/           # APK 修改补丁
```

## 许可证

MIT
