# 可共享的模型测试样本

这套样本用于在任意开发电脑复现数据结构、短语清单格式和模型输入构建，不包含模型密钥，不接入真实店铺，也不来自任何真实买家聊天。

样本全部是为本次公开快照虚构的中文客服片段：本次对话和短语独立编写，图片和商品卡片沿用原有合成素材，没有从旧聊天存档、日志或调度记录中抽取。内容覆盖规格、安装、清洁、物流、售后和上下文缺失等日常话题；其中若干段故意缺少前文，用来覆盖“只拿到部分上下文”时的输入形态。

这些只说明格式可用，不衡量真实商家回复质量、准确率或模型效果。

- `chats.json`：24 段虚构对话、共 209 条文本消息（17 段各 9 条，7 段各 8 条）。每段必须由买家消息结尾；消息 ID 依次为 `fixture-message-1`…，时间统一为 0，`kind` 均为 `text`。
- `phrases.json`：本套样本使用的全部虚构短句，唯一、互不重复，只含汉字；消息内容只用中文逗号 `，` 连接短语。每个短语至少出现一次。
- 因为没有完整上下文，每段明确标记 `history_complete: false`、`benchmark_partial_history: true`。不能把它们当作完整对话，用于真实发送、完整对话质量验收或证明业务回复准确率。
- `synthetic.png`：程序生成的 512×512 遮阳帘示意图，无真实买家图片及图片元信息。
- `goods_card.json`：虚构商品卡片，无真实订单或商品链接。

样本中不含原始聊天副本、运行日志、实际模型响应或调度记录，也不含网址、联系方式、订单号或店铺标识。订单、发送回执、unknown、主备故障等虚构数据仍在仓库其他测试文件中。

## 离线验证（macOS / Windows / Linux）

在仓库根目录运行（Python 3.11+，仅标准库）：

```sh
python3 -m unittest discover -s tests -p 'test_benchmark*.py' -v
python3 -m unittest discover -s tests -v
```

Windows 可将 `python3` 换成已安装解释器路径。测试使用固定模型响应，不请求模型、不操作平台，也不重放 unknown。样本测试会检查 24 段/209 条结构、编号、末尾买家、短语清单、上下文标记、禁止内容，以及 png/商品卡片的离线输入构建。

`backend/benchmark_metrics.py` 提供 `run_level(call, sample_count, concurrency)`，统计调用函数的成功率、有效完成数/分钟、P50/P95 和白名单用量字段；并发 1–12，每档 1–120 次。模块自身不发送网络请求、不重试。真实模型测试的超时和整体截止时间必须由调用方负责。耗时只统计 worker 内调用，不含排队；token 汇总仅包含成功样本的合法用量。

## Mac 开发入口

代码和依赖锁文件随 Git 克隆；依赖、私有配置和登录状态需在新电脑创建。
需要 Python 3.11+、Node.js 22.12+ 和 npm。仓库前台 `.nvmrc` 为 22。

```sh
# 仓库根目录，创建独立虚构配置，默认不启用回复
python3 -m backend init
python3 -m backend serve

# 另一个终端
cd apps/client
npm ci
npm run typecheck
CLAW_NEXT_USER_DATA="$(mktemp -d)" CLAW_NEXT_PYTHON="$(command -v python3)" npm test
npm start
```

管理页默认 `http://127.0.0.1:18880`。`init` 遇到已有配置会拒绝覆盖。
开发时使用模拟店铺，保留关闭自动回复的状态。图形验收另运行 `npm run smoke`。

前台口令使用 Electron 系统安全存储；Windows 密文、平台登录目录不能直接当作 Mac 可用配置。Mac 需重新配置口令和登录。
后台模型密钥在 macOS 上的 Keychain 存储、launchd 保活均已有实现，机制和边界见 [后台 macOS 说明](../../../backend/MACOS.md)。Windows 的 DPAPI 密文不能在 Mac 解密。
部署方不要把真实模型密钥写入 Git、测试文件或命令行。

代码实现、单元测试通过、进程启动、持久自启、Git 合并和真实业务验收是不同证据，须分别记录；这些离线样本不能代替各平台部署与真实业务验收。
