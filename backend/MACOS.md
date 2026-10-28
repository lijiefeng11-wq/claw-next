# macOS 后台密钥存储与 launchd

本文只涉及 Claw-Next 后台。前台仍使用自己的 Electron 安全存储；不读取其他系统的登录资料或真实业务数据。新数据目录中的店铺默认关闭自动回复。

## 模型密钥

- macOS 管理页保存的模型密钥进入当前用户 Keychain 的独立 generic-password 项；数据库只保存 `keychain:v1:<随机 ID>` 引用。使用 Security.framework 原生接口，不通过命令参数传递密钥，不枚举用户钥匙串，不解锁钥匙串、不弹授权窗口。
- Windows 使用当前用户 DPAPI 的 `dpapi:v1:` 密文。加密使用固定的应用附加熵和系统 DPAPI，不自行实现加密算法。兼容读取旧 `api_key_dpapi` 字段。Windows 密文不能在 Mac 解密；迁移机器或用户后应重新输入密钥。
- 其他系统拒绝从管理页持久保存密钥，不退回明文。原有环境变量方案仍可用。launchd 不继承交互式终端的环境变量，本生成器也不把环境变量值写进 plist；Mac 上应在管理页安全输入密钥。
- 主模型与备用模型分别保存。空白输入保留已有引用；替换先创建新项，数据库提交后才删除旧项；清除会关闭该槽位的环境变量回退。任何保存失败都不覆盖原配置。
- 钥匙串锁定、拒绝访问、引用丢失或跨平台密文只会产生安全错误码。管理页仍能查看和清除配置；模型调用不会偷偷改用环境密钥或无认证请求。主模型失败时可按已有规则使用备用模型，工作线程不因此退出。`key_configured` 表示有保存的凭据引用，实际可用性需点击测试确认。
- 旧数据库里的明文模型密钥在启动时迁移。先保护所有密钥，再原子替换数据库记录，清理当前 SQLite 页与 WAL；清理中断会在下次启动重试，完成前不提供服务。失败保留可恢复状态。此过程不能擦除历史备份、文件系统快照或其他副本；不要将数据库、配置或日志提交到 Git。
- Keychain 与 SQLite 不能共同提交事务。进程在两者提交间崩溃，或钥匙串拒绝删除时，可能留下已脱离配置的加密项；后台不会枚举或批量删除用户钥匙串。配置提交成功后，旧项清理失败只记安全事件，不伪称配置回滚。

不要把真实密钥放在 JSON 配置、shell 参数或普通日志里。机器、Python 安装路径或钥匙串权限变化后，应再次验证保存和调用；后台不会自动批准新的钥匙串权限。

## 先前台运行验证

使用 Python 3.11+ 的绝对路径，配置和数据放在独立私有目录；先按仓库 README 创建虚构配置。以下路径均为占位示例：

```sh
/absolute/python3 -m backend.service \
  --config /absolute/private/config.json \
  --data-dir /absolute/private/data \
  --port 18881
```

仅监听 `127.0.0.1`。访问 `/health` 和管理页，保持店铺自动回复关闭；不要导入真实登录状态作为启动验证。

## 生成、核对后再安装

在将来长期保留的代码目录执行：

```sh
/absolute/python3 -m backend.launchd \
  --python /absolute/python3 \
  --config /absolute/private/config.json \
  --data-dir /absolute/private/data \
  --output /absolute/private/com.claw-next.backend.plist \
  --port 18881
```

生成器只创建指定的 plist 和必要的数据/日志目录，不安装、不加载服务、不覆盖已有文件。plist 使用独立参数数组，支持路径中的空格和中文；文件权限为 600，新增数据目录为 700。现有目录权限需部署人员核对。不要使用其他系统的目录或已在使用的数据目录。

安装属于后续部署操作。先核对 Python、代码、配置、数据和端口，确认没有同名任务，再将审核后的 plist 放到当前用户 `~/Library/LaunchAgents/`，使用 `launchctl bootstrap gui/<UID> <plist绝对路径>` 加载。不要以 root 安装系统 LaunchDaemon。用户 LaunchAgent 需要该用户登录；退出登录或钥匙串不可用时，不保证模型调用可用。生成 plist 本身不代表安装或自启成功。

临时测试可从私有测试目录 bootstrap，无需放进登录启动目录。完成后用 `launchctl bootout gui/<UID>/<Label>` 撤销；只操作本次创建的准确 Label。停止长期自启还需移除对应的已安装 plist，避免下次登录重新加载。

## 保活与恢复边界

- `RunAtLoad` 启动；异常退出时 `KeepAlive.SuccessfulExit=false` 重启，间隔至少 30 秒。工作线程或 HTTP 线程死亡会结束整个服务。
- 每个数据目录在 300 秒内最多接受 3 次启动。计数在取得现有 Store 单实例锁之后、工作线程启动之前保存。预算耗尽、配置错误或启动故障以退出码 0 停住，防止无限重启；预算损坏也停住，不自动清空。
- 正常 SIGTERM/SIGINT 退出不自动重启。预算耗尽不会定时自行唤醒；排查日志、等待窗口过去后，再由部署人员对准确任务执行 `launchctl kickstart gui/<UID>/<Label>`。不要用循环删除状态文件的方式绕过预算。
- 服务入口不修改店铺开关、会话和投递契约。现有恢复逻辑继续将已领取但结果不明的消息保留为 `unknown`，不自动重发；不因为旧消息不确定而冻结整个买家会话。
- 元数据诊断在 `data/logs/backend.jsonl`，由现有日志器滚动保存。launchd 标准输出/错误输出只记录生命周期消息，部署时应纳入本机日志保留策略；日志不能提交到 Git。

## 验证

```sh
python3 -m unittest discover -s tests -v
CLAW_NEXT_TEST_KEYCHAIN=1 python3 -m unittest discover -s tests -p test_keychain.py -v
CLAW_NEXT_TEST_KEYCHAIN=1 python3 -m unittest discover -s tests -p test_model_secrets.py -v
```

默认测试不访问 Mac 钥匙串；显式启用的测试只创建虚构密钥并在结束时删除。Windows DPAPI 实机往返测试只在 Windows 执行。单元测试不会安装 LaunchAgent。应分别记录代码完成、测试结果、进程启动、持久自启、Git 合并和真实业务验收。

参考：[Apple SecItemAdd](https://developer.apple.com/documentation/security/1401659-secitemadd)、[禁止交互授权选项](https://developer.apple.com/documentation/security/ksecuseauthenticationuifail)、[Apple launchd.plist 手册源文件](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)。
