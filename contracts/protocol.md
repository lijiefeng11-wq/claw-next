# Claw-Next 协议 1.0

此文件是前后台共同基线。时间为 UTC Unix 秒，ID 为匹配 `[A-Za-z0-9_.:-]{1,128}` 的字符串；HTTP JSON UTF-8。后台启动时配置店铺和客户端身份；**请求内的店铺名不授予权限**。前台 token 固定绑定一个 `client_id` 和一个 `shop_id`。所有受保护 API 使用 `Authorization: Bearer <token>`，禁止放 URL。管理员使用账号密码换取短期会话，管理员会话和客户端 token 不能互相替代。示例全部是虚构数据。

开发地址默认 `http://127.0.0.1:18880`；云端使用 HTTPS 反向代理。v1 不依赖其他系统的任何端口/配置。客户端从后台响应确认 `protocol_version=1.0`，不支持的主版本停用发送。JSON 错误统一 `{"error":{"code":"...","message":"..."}}`；400=格式错误，401=未认证，403=角色错误，404=不存在，409=状态冲突，413=过大。未知接口不执行任何业务。请求体按完整 JSON 编码后的 UTF-8 字节数计量，默认上限 256 KiB（262144 字节）。POST 特例：`/api/v1/events` 和 `/api/v1/admin/chat-import` 为 8 MiB（8388608 字节），`/api/v1/admin/rule-draft` 为 4 MiB（4194304 字节）；其他接口不放宽。超过对应请求体上限返回 413 `body_too_large`，字段自身的限制另行校验。

## 健康与身份

`GET /health` 无认证，返回 `{"service":"claw-next","protocol_version":"1.0","status":"ok"}`。这仅说明 HTTP 服务可达。

`GET /api/v1/me` 返回当前身份。客户端返回 `{"role":"client","client_id":"demo-client","shop_id":"demo-shop","protocol_version":"1.0"}`，管理员返回 `{"role":"admin","username":"admin","must_change_password":false,"protocol_version":"1.0"}`；仍使用初始密码时 `must_change_password` 为 `true`。客户端身份响应不增加此字段。

## 管理员登录与密码迁移

此更新只替换管理员认证；每店客户端 Bearer token、身份、消息、租约、claim 和回执字段及语义保持 1.0。前台收发客户端不得调用管理员登录来取得店铺权限。

- `POST /api/v1/admin/login`：无认证，JSON `{"username":"admin","password":"admin"}`。成功 200：`{"role":"admin","username":"admin","session_token":"<不透明会话值>","expires_at":1790028800.0,"must_change_password":true,"protocol_version":"1.0"}`。后续管理 API 用此会话值作 Bearer；禁止 URL、日志或持久化浏览器存储。账号密码错误统一 401 `invalid_credentials`，格式错误 400。首次初始化默认 admin/admin；已有管理员密码不会被启动配置覆盖。`must_change_password` 表示当前持久化密码仍为初始密码；已改密账号登录时为 `false`。
- `POST /api/v1/admin/password`：管理员 Bearer，JSON `{"current_password":"admin","new_password":"<新密码>","confirm_password":"<相同新密码>"}`。新密码 8–128 字符，不能等于当前密码。成功 200 `{"ok":true,"reauthenticate":true}`，立即撤销全部管理员会话（包括当前会话）；旧密码失效，必须重新登录。错误当前密码 403 `current_password_incorrect`；确认不一致 400 `password_mismatch`；新密码太短 400 `invalid_new_password`；与当前相同 400 `password_unchanged`；缺失、类型/编码错误或超过长度上限 400 `invalid_password_request`。这些失败不改变密码、首次改密状态或现有会话；新密码成功提交后才清除首次改密状态并撤销会话。
- `POST /api/v1/admin/logout`：管理员 Bearer，JSON `{}`。200 `{"ok":true}` 仅撤销当前会话。响应丢失时客户端不能声称服务端已确认退出；可以丢弃本地会话并提示。

当 `must_change_password=true` 时，该管理员会话只允许 `GET /api/v1/me`、`POST /api/v1/admin/password` 和 `POST /api/v1/admin/logout`；其余管理接口（含模型连接测试）在读取业务数据、修改配置或调用模型前返回 403 `admin_password_change_required`。管理界面必须先完成改密，不能仅隐藏提示后继续读取业务数据。原有客户端 token 与客户端接口不受此管理员门槛影响。协议版本仍为 1.0；旧管理调用方收到该错误时应引导改密，不能自动重试原操作。

测试初始化应使用隔离的虚构数据目录：默认登录后通过正常改密接口设置本次测试专用密码，再重新登录取得新会话。不得添加绕过首次改密的测试开关。

会话为服务端内存保存的随机值（只保存摘要），最长 8 小时绝对有效期；到期、退出、改密或后台重启后返回 401 `unauthorized`。管理页只在内存保存会话，刷新后重新登录。最多保留 64 个有效管理员会话，超出时撤销最早到期的会话。未登录不能访问管理接口；客户端 token 访问管理接口为 403，管理员访问客户端业务接口也为 403。

登录及改密的错误密码按连接来源地址共用限制：60 秒内 10 次失败后返回 429 `login_rate_limited`，到期后可再次尝试；不信任客户端提供的代理地址头。远程部署仍需 HTTPS 代理及入口限流，代理下多个用户可能共用同一来源地址。

管理员使用独立盐及 PBKDF2-HMAC-SHA256（600,000 次）持久化到数据目录 `admin.sqlite3`，不保存明文密码。旧配置可保留 `admin_token` 字段，但该值永远不参与管理员认证，也不能与客户端 token 相同。新版初始化配置不再生成管理员静态 token。升级时保留整个数据目录；不要删除管理员数据库来重置密码。默认 admin/admin 只用于首次登录，必须先在回环地址完成改密，再考虑受控远程访问。已使用自定义密码的旧安装不重复强制；仍使用默认密码的旧安装升级后同样受此限制，不迁移数据库结构。

## 1. 取得并续租发送归属

`POST /api/v1/heartbeat`，客户端请求：

```json
{"instance_id":"instance-001","session_id":"session-001"}
```

响应 `{"shop_id":"demo-shop","client_id":"demo-client","instance_id":"instance-001","session_id":"session-001","generation":1,"expires_at":1790000060.0}`。

租约 60 秒，每 15 秒续租。相同客户端同一实例/会话续租保持 generation；其他实例或客户端在有效租约期内返回 409 `lease_busy`。会话更换只允许当前实例（旧会话任务随即失效）或原租约过期后新实例取得；generation 增加。失联、过期、实例或代数不匹配时禁止新任务和发送。客户端每次启动生成新 instance_id，平台重新登录/切店时生成新 session_id。后台租约只能协调 Claw-Next 客户端，**不能自动阻止其他自动回复工具发送**。

以下需要身份归属的请求携带同一组字段 `instance_id, session_id, generation`。

## 2. 提交新消息及完整上下文

`POST /api/v1/events`：

```json
{
  "event_id":"event-001",
  "instance_id":"instance-001","session_id":"session-001","generation":1,
  "conversation_id":"buyer-demo-001","message_id":"message-001","context_revision":1,
  "received_at":1790000000.0,
  "context":{"history_complete":true,"messages":[
    {"id":"message-001","role":"buyer","kind":"text","content":"营业时间是什么时候？","created_at":1790000000.0}
  ]}
}
```

`message_id` 必须是上下文最后一条消息，角色 buyer。每个消息必须有 id/role/kind/content/created_at；role 为 buyer/agent/system，kind 为 text/image/card/unsupported；消息按时间非递减排序，id 不重复。上下文 1–200 条，每条 content 最多 8000 字符；超限拒绝，前台不得截断后伪称完整。图片/卡片保存可读文字或安全的占位描述；history_complete=false 的上下文返回转人工，不猜测。图片与卡片按下文“图片与卡片（1.0 补充）”处理，不再一律转人工。

### 图片与卡片（1.0 补充）

消息可带两个可选字段。旧字段保持兼容；最新买家图片缺图时后台会请买家补发，历史中的非文字消息不再单独导致转人工：

```json
{"id":"message-009","role":"buyer","kind":"image","content":"[图片]","created_at":1790000300.0,
 "attachments":[{"type":"image","mime":"image/jpeg","data_url":"data:image/jpeg;base64,..."}]}
{"id":"message-010","role":"buyer","kind":"card","content":"商品卡片：示例商品","created_at":1790000310.0,
 "card":{"type":"goods","title":"示例商品","description":"规格：示例","fields":[{"label":"价格","value":"示例"}]}}
```

- `attachments` 只允许出现在上下文**最后一条 buyer 消息**上，其他位置 400。每项 `type=image`，`mime` 只能是 `image/png` / `image/jpeg` / `image/webp`，且必须与 `data_url` 头部一致；最多 3 张，每张解码后不超过 2 MiB；超过 3 张或超过大小返回 413，其他格式不符返回 400。前台不压缩、不截断冒充原图。
- 前台只在本店已登录的平台页面中读取该消息的图片，只取平台自身图片域名；后台不持有平台 Cookie，不抓取任何网址。前台本地只记录图片大小和哈希，不落盘图片。
- 历史图片（非最后一条）只保留 `kind=image` 与占位 content，不带数据；后台须视为“未看过”，不得声称看过。最新图片前台未能取到时不带 attachments，content 写“[图片，前台未取到]”；后台可回复请买家补发，不冻结会话。
- 仅 model 与 hybrid 模式会把 attachments 作为多模态图片输入交给已授权的模型链；rules 模式不调用模型，带图片的最新消息按未命中转人工。各模式共用的前置判断（店铺关闭、上下文不完整等）先于此执行，不会因有图片而强行调用模型；最新图片缺少数据时仍按上一条请买家补发。某模型接口实际不接受图片时按模型失败处理：先按现有主备策略尝试备用模型，主备均不可用时才转人工；不得假装理解。
- `card` 为纯文本结构：`type` 为 `goods` / `order` / `source` / `system`；`title`（不超过 500 字）、`description`（不超过 4000 字）可选；`fields` 最多 10 项，`label` 非空且不超过 20 字，`value` 不超过 200 字；任何字段不得含 URL。缺失时不传，content 仍须是可读描述。平台来源卡片与系统提示卡片为 `role=system, kind=card`，type 分别为 `source` / `system`。

### 订单、物流与备注（1.0 补充，只读）

`context` 可带可选字段 `orders`，是前台从本店已登录平台页面**自身已加载的数据**中读到的该买家订单摘要；前台不主动调用订单接口、不伪造风控参数。旧客户端不传时行为不变。

```json
"orders":[{"order_ref":"o-1","status":"已发货","goods_title":"示例商品","sku":"示例规格","quantity":1,
  "amount":"19.90","order_time":1790000000,"shipping_time":1790003600,"receive_time":null,
  "after_sale":"无","note":"示例备注",
  "logistics":{"company":"示例快递","tracking_number":"示例单号","state":"运输中",
    "traces":[{"time":1790007200,"info":"示例轨迹"}],"observed_at":1790007900},
  "observed_at":1790008000}]
```

字段与类型（未列出的字段一律 400）：

| 字段 | 必填 | 类型与限制 |
|---|---|---|
| `order_ref` | 是 | 非空字符串，≤200 字符，数组内唯一；前台生成的对话内引用（不是平台订单号），同一订单在同一对话中保持不变 |
| `observed_at` | 是 | Unix 秒（数字）；该订单摘要**实际从页面读到**的时间 |
| `status` `goods_title` `sku` `amount` `after_sale` | 否 | 字符串，≤200 字 |
| `note` | 否 | 字符串，≤500 字 |
| `quantity` | 否 | 正整数（布尔值无效） |
| `order_time` `shipping_time` `receive_time` | 否 | Unix 秒（数字）；未知可缺失或 null |
| `logistics` | 否 | 对象：`company` `tracking_number` `state`（字符串，≤200 字）、`traces`（数组，≤5 条，按时间倒序，每条 `{time: Unix 秒数字, info: 字符串 ≤200 字}`）、`observed_at`（Unix 秒，物流单独读取的时间，必填于 logistics 内） |

- 最多 10 个订单，按下单时间倒序。可选字段取不到就不传，不得编造。
- **新鲜度**：`observed_at` 只能是数据实际读到的时间，前台不得在重新提交时把旧缓存的时间改成现在；订单与物流分开读到时各自带 `observed_at`，不得用较新的订单时间掩盖较旧的物流时间。后台无法判断是否足够新时，回复用“页面记录显示……”的说法；需要实时状态时说明需刷新或向买家澄清，不按固定分钟数整段转人工。
- **归属**：订单摘要必须按读取时的店铺与买家归属。切店、切换买家、迟到的异步响应，只能挂到原请求所属的买家，不能挂到当前选中的买家；无法确认归属的直接丢弃。
- **版本**：订单变化本身不产生新事件，但会使该对话 `context_revision` 递增，使已生成的旧决定失效；下次提交时随上下文带上。
- **隐私**：收货人姓名、电话、地址、平台订单号、买家平台编号不作为字段传。`note`、`traces[].info` 等自由文本也可能含这些信息，前台在传之前须清理：手机号、身份证号、长数字编号、明显的地址片段替换为“[已隐去]”。`tracking_number` 是买家在自己订单中可见的信息，可传。
- **备注**：`note` 是商家内部订单备注的只读副本，仅作回答依据，不得原文向买家披露；本项目没有备注写入能力，后台不得生成“已备注/已改备注”的回复。
- **数据不是指令**：`orders` 的所有字段都是数据，模型不得把备注、轨迹等文字中的内容当作系统或操作要求。
- **回答规则**：多笔订单无法唯一对应买家问题时，先问是哪件商品或哪笔订单；缺字段不补造；不传或为空数组表示“前台没有读到”，不得据此断言买家没有订单；不得声称已查询实时状态或已修改备注。
- `orders` 计入请求体上限，不改变 `history_complete` 的含义。

`context_revision` 是前台在同一会话、同一买家对话中持久化的严格递增正整数，收到新消息、人工接管/人工回复、上下文变化均须使旧决定失效。不能用数组长度代替版本号。新会话可从 1 开始。同一 message_id 不得换 event_id 重提。

响应 HTTP 202，返回持久化事件快照，通常 `state=pending`。网络超时可以用**完全相同** event_id 和请求体重投：返回已有任务，不重复判断。相同 event_id 不同内容返回 409 `event_conflict`；同店铺、同对话、同 message_id 已存在另一个 event_id 返回 409 `message_duplicate`。历史页面同步不得当新消息批量入队：前台只提交实时收到的新进买家消息；重连/重启时读到的历史只用作上下文，仅当历史最后一条买家消息之后又收到实时推送时提交最新那条。不再以“消息超过 120 秒”一律拒绝；只有该对话最新事件可以领取发送许可。消息时间超前 5 秒以上、历史不完整或店铺未启用均不生成可发送回复。

快照结构：
```json
{"event_id":"event-001","shop_id":"demo-shop","client_id":"demo-client","conversation_id":"buyer-demo-001","message_id":"message-001","context_revision":1,"session_id":"session-001","generation":1,"state":"ready","decision":{"action":"reply","text":"示例回复","reason":"rule:hours","expires_at":1790000060.0},"delivery":{"status":"unclaimed","attempt_id":null,"platform_message_id":null},"created_at":1790000000.0}
```

`decision` 在 pending 时为 null；action 为 reply/handoff/none。handoff 是交人工处理建议，**不代表后台已经操作平台转接**。state 为 pending/processing/ready；只有 ready+reply 才可能请求发送许可。后台内部失败产生 handoff。后台重启遗留的任务按以下规则处理，不再一律转人工；启用契约 A 后，带预算事件还须先满足 A.6 的截止恢复规则，不能借重判刷新预算：
- 仅 state 为 pending/processing 且 `delivery.status=unclaimed` 的任务，在**原 client + instance + session** 重新心跳后重新判断；保持原 generation 与原请求内容/摘要，仍须满足最新消息、版本与上下文检查。
- 若重新心跳的是其他 instance 或 session，旧任务结束为 `action=none`（superseded），不再判断。
- 已 ready 的既有判断结果不重算。
- 未完成的 claim 归为 unknown，已存在的 unknown 不变；二者都永不重发、不重新判断。

## 3. 读取判断

`GET /api/v1/events/{event_id}`，原客户端 token；其他客户端/店铺看不到任务。pending/processing 时建议 0.5–1 秒轮询，网络失败指数退避。回复有效期最多 60 秒，取回晚了不能发。

## 4. 发送前最后一次核验

先在前台确认：当前登录店铺、会话、连接、上下文版本、最新消息、人工接管状态、完整历史均有效。再发：

`POST /api/v1/events/{event_id}/claim`
```json
{"instance_id":"instance-001","session_id":"session-001","generation":1,"attempt_id":"attempt-001"}
```

后台核验有效租约、最新消息/版本、回复有效期、店铺当前启用状态及设置版本、一单一发送尝试，成功返回更新后的事件快照及 `delivery.status=claimed, delivery.claim_expires_at`（10 秒）。启用契约 A 后，预算事件还须满足 A.4 的截止核验；已领取 attempt 的重复查询不刷新预算或许可。许可只适用于该事件原文，前台不得改写判断文案。**发送前还必须在本地重新检查新消息和人工状态，并先持久化发送尝试**；服务端许可无法消除平台与后台间的竞态。

首次 claim 后该事件不再分配第二个发送尝试。重复相同 attempt_id 可查询原许可；它绝不表示可以再次调用平台发送。claim 响应丢失可先查询任务，仅当前台日志明确证明从未开始平台请求且许可仍有效时继续首次发送；否则 unknown。claim 超时或后台重启，未完成的 claim 归为 unknown。店铺/会话/上下文失效均返回 409。客户端不可因后台无响应而本地判断并自动回复。

## 5. 回执

`POST /api/v1/events/{event_id}/receipt`
```json
{"attempt_id":"attempt-001","status":"sent","platform_message_id":"platform-message-001"}
```

status 只能 sent/not_sent/unknown。sent 必须具有平台明确成功回执与非空 platform_message_id；HTTP 200 或传输 ACK 不能冒充平台确认。只有确定没有调用平台发送时才使用 not_sent；发送后超时、丢失回执、崩溃均 unknown。回执可以原样重复上报；相互矛盾的回执 409。unknown 永久保留，后续 sent/not_sent 不覆盖；该事件不能再次 claim、永不重发，也没有清除或自动重发接口，并提示人工核查。unknown 只锁定该条事件，不冻结整个对话：同一买家之后的新消息作为新事件照常判断与发送（仍受租约、最新消息、完整历史、版本、时效、店铺开关等全部检查）。回执上报失败时本地持久化待上传，但不得重发买家消息。sent 只是客户端报告的平台发送确认，不等于真实业务问题已解决。

## 聊天页附加发送（1.1 草案，双方审查通过前不生效）

在文字回复之外，允许后台决定发送店铺在平台上**已有**的三类内容：商品说明书、商品卡片、视频库视频。图片在平台上只能本地上传，本版本不支持；邀请下单、改价、申请售后、备注不在本版本。本段生效后，上文“action 为 reply/handoff/none”“只有 ready+reply 才可能请求发送许可”在**双方确认支持 send_item** 时扩展为“reply/handoff/none/send_item”“ready+reply 或 ready+send_item”；未确认时仍按原文。

### 能力协商

- 心跳请求可带可选字段 `capabilities`（字符串数组，最多 10 项，每项 ≤32 字符，不重复）。本段定义 `"send_item"`；独立能力 `"reply_deadline"` 见下文“契约 A”，该扩展当前尚未启用。
- 心跳响应带 `capabilities`：服务端支持且客户端声明了的能力交集；旧后台不返回该字段，视为空。
- 能力以**最近一次成功心跳响应**为准，按 instance + session + generation 绑定；租约变化后须重新确认。
- 同一租约续租时能力被撤回（响应不再含 `send_item`）：在途判断不得产出 send_item；已生成的 send_item 不能再领取许可（claim 返回 409）；客户端点击前发现能力已撤回则不点击，按 `not_sent` 处理。已开始平台发送的事件只收集本次结果，绝不因能力变化重发或改写 unknown。
- 仅当本租约已确认 `send_item` 时：客户端才可在上下文中带 `send_options`，后台才可返回 `action=send_item`。未确认时后台只返回旧 action；客户端收到不认识的 action（或未确认能力却收到 send_item）一律不执行、不 claim，本地按 none 记录。
- 兼容组合：旧客户端 + 新后台（不声明能力 → 不出现 send_item；新后台对未确认能力的事件中的 `send_options` 返回 400）；新客户端 + 旧后台（响应无 `capabilities` → 客户端不传 `send_options`，旧后台不会产生 send_item）。

### 候选（前台提交）

`context.send_options` 是前台在**本店已登录平台页面、该买家对话中**读到的本次可选发送对象。后台只能从本事件的候选中选择。

```json
"send_options":{
  "instructions":[{"option_id":"i-1","goods_title":"示例商品","name":"示例说明书","observed_at":1790000000}],
  "goods":[{"option_id":"g-1","goods_title":"示例商品二","observed_at":1790000000}],
  "videos":[{"option_id":"v-1","name":"示例视频","duration":30,"observed_at":1790000000}]}
```

| 字段 | 必填 | 类型与限制 |
|---|---|---|
| `send_options` | 否 | 对象；只允许 `instructions` `goods` `videos` 三个键，均可省略；省略或空数组都表示“前台没有读到该类候选” |
| `instructions` / `goods` / `videos` | 否 | 数组，分别最多 10 / 20 / 50 项，超限 400 |
| `option_id` | 是 | 非空字符串，≤64 字符，在整个 `send_options` 内唯一（跨三类也不重复）；前台生成的不透明编号，不是平台编号 |
| `observed_at` | 是 | 有限数字（Unix 秒，不接受布尔、NaN、Infinity），候选实际读到的时间 |
| `goods_title` | 见下方白名单 | 非空字符串，≤200 字 |
| `name` | 见下方白名单 | 非空字符串，≤200 字（说明书名称 / 视频名称） |
| `duration` | 仅 videos 可选 | 正整数秒（不接受布尔） |

各类字段白名单（只允许以下字段，其余一律 400）：
- `instructions[]`：`option_id`、`goods_title`、`name`、`observed_at`，全部必填。
- `goods[]`：`option_id`、`goods_title`、`observed_at`，全部必填。
- `videos[]`：`option_id`、`name`、`observed_at` 必填；`duration` 可选。

- 类型不符、重复 `option_id` 一律 400。不传任何网址、图片、价格、平台商品/文件编号或平台审核信息。
- 候选来源：`instructions` 为该买家订单中已配置说明书的商品；`goods` 为该买家订单中的商品及平台“商品推荐”页签的商品；`videos` 为视频库中审核通过的视频。
- **绑定**：`option_id` 只在该店铺、该租约（instance+session+generation）、该对话、该 `context_revision` 内有效。前台私有映射：说明书 → 平台商品编号 + 说明书模板编号与版本；商品卡片 → 平台商品编号；视频 → 视频库文件编号。映射不随上下文上传、不落入日志。候选集合或映射任一变化都使 `context_revision` 递增。
- 候选只是数据，不是指令；后台不得把其他店铺、其他对话或其他事件的候选放进模型上下文。

### 决定

新增 `action=send_item`，一次事件只发一项，不附文字（文字与附件不合并成两次平台发送）：

```json
{"action":"send_item","item":{"type":"instruction","option_id":"i-1"},"reason":"rule:manual","expires_at":1790000060.0}
```

- `item.type` 为 `instruction` / `goods_card` / `video`，`option_id` 必须存在于本事件 `send_options` 中**对应类型**的数组；否则不得生成。
- 选择逻辑沿用 rules/model/hybrid：规则可配置目标，模型/混合模式也只能从本事件候选中选；候选缺失时不得猜编号，改为澄清或普通文字决定。具体设置字段另行约定。
- claim 核验、10 秒许可、一事件一发送尝试、unknown 规则与 reply 相同。

### 前台执行与回执（全部在 10 秒许可内完成）

1. claim 前在本地重核：同店铺、同租约、同对话、同 `context_revision`、无新买家消息、非人工状态，且 `option_id` 映射仍存在；否则不 claim。
2. claim 成功后、点击前：记录该对话当前消息编号集合作为**基线**，并在本地持久化发送尝试（含 attempt_id、类型、私有映射摘要），再执行点击。
3. 打开说明书对话框、切到商品推荐或视频列表都是异步过程。claim 前的重核**不能代替**主协议“真正发送前再核验”：在点击发送的那一刻之前，须再次核对店铺、租约、会话、最新消息、`context_revision`、人工状态、已协商能力与候选映射，并确认尚未到确认截止（见第 5 步）。任一不满足，或准备阶段已越过 `claim_expires_at − 2 秒`，则不点击，按未开始发送报 `not_sent`。
4. 点击只用平台页面自身按钮（订单里的“发送说明书”、商品推荐里的“发送商品”、视频列表里的“发送”），不自行拼接平台请求、不伪造风控参数。点击前确认页面对象就是原候选：说明书对话框加载的模板编号与版本须与映射一致；商品卡片须为映射的商品编号；视频行须为映射的文件编号（不能只比名称）。不一致则关闭对话框、不点发送，回执 `not_sent`。
5. **确认截止 = claim_expires_at − 2 秒**（留出回执上报时间）。截止前须同时满足才报 `sent`：
   - 平台该发送接口明确返回成功；
   - 该对话相对基线**恰好新增一条**本店客服方向、对应类型的消息，且其内容能对应到目标对象（商品/说明书/视频身份一致）；该消息的平台编号作为 `platform_message_id`。
6. 截止前任一条件不满足，或同期出现多条同类型新增消息无法唯一对应、或对象不一致，一律报 `unknown`；不重发、不覆盖、只锁定该事件，同一买家后续新消息照常处理。前台尚未点击发送即中止的，报 `not_sent`。
7. 本版本不延长许可、不改变 unknown 状态机；若实测 8 秒内无法稳定完成确认，再另提状态机变更。

### 测试要求（实现阶段）

至少覆盖：能力协商四种组合（新旧客户端 × 新旧后台）、未确认能力时的 `send_options` 与 `send_item`、字段校验（必填、类型、上限、重复、未知字段）、无效或跨类型 `option_id`、跨店/跨会话/旧 revision 候选、许可第 10 秒边界与截止后确认只能 unknown、对象不一致或多条同类型新增消息不得报 sent、等待对话框/列表期间来了新消息或切换买家或越过确认截止时不点击并报 not_sent、决定生成后同一租约撤回能力（在途判断、claim、点击前三处）。

## 商品快照（1.2 草案，双方审查通过前不生效）

让后台知道本对话涉及哪些商品，以及前台是在哪里、什么时候读到的，便于按商品匹配店铺规则和本地资料。商品快照**不是价格、库存或优惠的来源**。数据只取本店已登录平台页面**自身已加载的数据**；前台不主动打开商品页、不调用商品接口、不读 Cookie。

### 能力协商

- 心跳 `capabilities` 新增能力名 `"goods_snapshot"`，规则与 `send_item` 相同：以最近一次成功心跳响应为准，与 instance + session + generation 绑定。
- 仅当本租约已确认 `goods_snapshot` 时，前台才可在上下文中带 `context.goods` 和 `orders[].items`；未确认时后台对这两个字段返回 400。
- 兼容组合：
  - 旧客户端 + 新后台：不声明能力，就不带这两个字段，行为不变。
  - 新客户端 + 旧后台：响应里没有该能力，前台不带这两个字段。

### 商品条目的身份（`goods_ref`）

- 每个条目有一个**来源身份**：
  - 读到平台商品编号时，身份就是这个编号；
  - 读不到编号时，身份就是完全相同的标题。
- `goods_ref` 由店铺、对话和来源身份经摘要生成，**在同一对话内不随 `context_revision` 变化**：同一来源身份在任何一次提交里引用都相同。
- 平台商品编号不上传，也不出现在 `goods_ref` 中。
- 前台**不把“有编号”和“只有标题”两种身份合并**，即使标题相同、当前集合里恰好只有一个同名编号也不合并。因此：
  - 两个条目标题相同，可能是同一件商品，也可能不是；
  - 后台不得据此认定它们是同一件，也不得认定它们不是同一件；
  - 需要区分时，向买家确认。
- 同一编号的商品改了标题时，`goods_ref` 不变，`title` 取最近一次读到的标题。

### `context.goods`

```json
"goods":[{"goods_ref":"g-1","title":"示例商品","evidence":[
  {"source":"order","order_ref":"o-1","observed_at":1790008000},
  {"source":"goods_card","message_id":"message-007","card_price":"示例价格文字","observed_at":1790000310}]}]
```

| 字段 | 必填 | 类型与限制 |
|---|---|---|
| `goods` | 否 | 数组，最多 10 项，按各项最新 `evidence.observed_at` 倒序；省略或空数组表示“前台没有读到”，不表示买家没有涉及商品 |
| `goods_ref` | 是 | 非空字符串，≤64 字符，数组内唯一；生成规则见上文“身份” |
| `title` | 是 | 非空字符串，≤200 字，不含网址 |
| `evidence` | 是 | 数组，1–5 项，按 `observed_at` 倒序，同一 `order_ref` 或同一 `message_id` 只出现一次；每项是读到该商品的一处来源 |
| `evidence[].source` | 是 | `order`：该买家的某笔订单里有这件商品；`goods_card`：本对话某条消息是这件商品的卡片 |
| `evidence[].observed_at` | 是 | 有限数字（Unix 秒）。`source=order` 时**等于**该订单摘要的 `observed_at`（实际从页面读到的时间）；`source=goods_card` 时**等于**该消息的 `created_at`（卡片展示价对应的时刻） |
| `evidence[].order_ref` | `source=order` 时必填，其他来源不得出现 | 须等于本上下文 `orders[].order_ref` 之一，且该订单的 `items` 里有引用本条目 `goods_ref` 的明细 |
| `evidence[].message_id` | `source=goods_card` 时必填，其他来源不得出现 | 须等于本上下文 `messages[].id` 之一；该消息须为 `kind=card`、`card.type=goods`，且 `card.title` 等于本条目的 `title` |
| `evidence[].card_price` | 仅 `source=goods_card` 可选 | 卡片上显示的价格文字（≤200 字），即**卡片发出时的展示价** |

- 未列出的字段一律 400。各来源只允许上表列出的字段，字段与来源不匹配（例如 `source=order` 却带 `card_price`）也返回 400。
- 规格和件数**只放在订单明细 `orders[].items` 里**，不放在 `evidence` 中：同一订单里同一件商品可能有多个规格，`evidence` 只说明“这笔订单里有这件商品”。

### `orders[].items`

订单摘要增加可选字段 `items`，数组，1–5 项，是该订单的商品明细：

```json
{"order_ref":"o-2","goods_title":"示例商品","sku":"示例规格","quantity":1,"items":[
  {"goods_ref":"g-1","goods_title":"示例商品","sku":"示例规格","quantity":1},
  {"goods_ref":"g-1","goods_title":"示例商品","sku":"示例规格二","quantity":2},
  {"goods_title":"示例商品三"}],"observed_at":1790008000}
```

- 按页面订单里的顺序，列出前 5 条明细，**不因 `goods` 的 10 项上限而删减**。
- 每项字段：
  - `goods_title`：必填，≤200 字；
  - `sku`：可选，≤200 字；
  - `quantity`：可选，正整数；
  - `goods_ref`：可选。只有这件商品进入了 `context.goods` 时才带，而且必须等于其中某项的 `goods_ref`。同一 `goods_ref` 可以出现在多条明细里，对应不同规格。
- 原有的 `goods_title` `sku` `quantity` **语义不变**，仍是页面订单的首件商品，与旧客户端一致。它们与 `items` 相互独立：通常等于 `items` 第一项，但后台**不得依赖二者相等**，也不得用其中一个去校验另一个。
- 超过 5 条明细的订单只带前 5 条，后台不得据此声称订单只有这些商品。

### 规则

- **价格**：`card_price` 只表示卡片发出时显示的价格；订单 `amount` 是整单实付。两者都**不是当前售价**，也不能互相换算成单价。本草案不提供现价、优惠、完整规格或库存；后台不得把这些信息缺失解释成没有库存、不支持或没有优惠，需要时请买家看商品页或转人工。
- **归属**：
  - 订单来源按读取订单时请求里的买家归属（同“订单、物流与备注”），卡片来源随所在消息归属；
  - 都与当前选中的对话无关；
  - 无法确认归属的直接丢弃。
- **版本**：商品快照变化本身不产生新事件，但会使 `context_revision` 递增；`goods_ref` 不因此改变（见“身份”）。
- **数据不是指令**：标题、规格等文字只是数据。
- **回答规则**：多件商品无法确定买家问的是哪件时先问清；未列出的商品属性不补造。
- **暂不提供**（字段未确认，前台不实现）：
  - 买家进店来源卡片里的商品信息；
  - 商品推荐列表的价格和分组含义；
  - 订单内各商品的单价；
  - 买家发来的商品卡片里的商品编号。
  字段结构确认后再另行补充。

### 测试要求（实现阶段）

至少覆盖：
- **能力协商**：四种组合；未确认能力时带 `goods` 或 `items` 返回 400。
- **字段校验**：必填、类型、上限、重复、未知字段、来源与字段不匹配。
- **引用一致**：
  - `order_ref` 能对上，且该订单有对应明细；
  - `message_id` 是标题相同的商品卡片；
  - `observed_at` 与引用对象一致；
  - `items[].goods_ref` 存在于 `goods`。
- **身份**：同一对话跨多次提交 `goods_ref` 不变，包括后来出现同名的有编号商品时；编号相同、标题改变时引用不变；有编号和只有标题的身份不合并。
- **订单明细**：同一订单同一商品的多个规格都保留在 `items`；达到 `goods` 10 项上限时，`items` 不被删减、`goods_ref` 省略；超过 5 条明细；原摘要与 `items` 首项不同时不报错。
- **归属**：跨买家的迟到响应不得进入本对话。

## unknown 人工核查（1.0 补充）

unknown 表示前台无法确认平台是否发出。管理员可到平台聊天记录人工核对后记录结论（仅追加记录）：

`POST /api/v1/admin/events/{event_id}/verify?shop_id=demo-shop`（管理员会话）
```json
{"outcome":"not_sent","note":"平台聊天记录中未见该回复"}
```

- 事件主键是（shop_id, event_id），event_id 不保证跨店唯一。管理界面必须传 `shop_id`；不传时仅在全库唯一匹配时执行，跨店同名返回 409 `ambiguous_event` 且不修改任何记录。成功返回更新后的事件快照；核查的管理员账号仅服务端审计保存，不在快照中返回。
- 仅当该事件 `delivery.status=unknown` 且尚未核查时可用；否则 409。outcome 只能 `sent` / `not_sent`；note 必填，1–200 字，只写核查依据，不写买家原文。
- 核查不改写 unknown：`delivery.status` 保持 `unknown`，事件快照新增 `delivery.verification={"outcome":"not_sent","note":"...","verified_at":1790000000}`（未核查为 null）。核查后不可再改；后台记录核查的管理员账号。
- 核查只是审计记录，不是同对话后续回复的前提（unknown 本来就不冻结对话）；被核查的旧事件仍**永不重发**，也不能再次 claim。
- 前台本地保留 unknown 记录、不删除；本地同样只禁止该条事件再次发送，不阻挡同一买家的新消息，也无需轮询核查结果。
- outcome=`sent` 只表示管理员核实平台已发出，不补 platform_message_id，也不等于业务问题已解决。

## 管理 API（仅管理员）

- `GET /api/v1/admin/summary`：`{"counts":{"pending":0,"processing":0,"ready":0,"sent":0,"unknown":0},"protocol_version":"1.0"}`。
- `GET /api/v1/admin/shops`：`{"shops":[{"shop_id":"demo-shop","name":"演示店铺","settings":{...},"lease":null或租约}]}`。
- `GET /api/v1/admin/events?shop_id=demo-shop&limit=50`：`{"events":[事件快照...]}`；limit 1–200，不传店铺查全部。
- `POST /api/v1/admin/prompt-draft`：根据管理员本次输入生成未应用的提示词草稿，详见下方“管理员提示词草稿”约定；不写入店铺设置。
- `PUT /api/v1/admin/shops/{shop_id}/settings`：完整替换下列设置，后台增加 version；修改后旧未发送决定失效。
```json
{"enabled":false,"mode":"rules","system_prompt":"仅根据所提供的店铺规则回答；无法确认则转人工。","rules":[{"id":"hours","contains":"营业时间","reply":"演示：营业时间请咨询人工客服。"}]}
```
混合模式示例：
```json
{"enabled":true,"mode":"hybrid","system_prompt":"仅根据所提供的店铺规则回答；无法确认则转人工。","rules":[{"id":"shipping","contains":"发货","description":"问什么时候发货、几天能到","reply":"演示：付款后48小时内发货。"}]}
```
settings 返回上述字段加 version。mode=rules/model/hybrid。规则可带可选 `description`（适用问题说明，如“问发货时间、几天到”；字符串，最多 500 字符；不传或空串表示无），只用于混合模式的语义匹配，不会发给买家。

- **rules**：规则按列表顺序做不区分大小写的字符串包含匹配（只看最新买家文字消息）；未命中转人工。**规则模式的业务判断不调用模型**，即使后台已配置模型；管理员主动连接测试和草稿生成独立于业务判断方式。
- **model**：只用模型（主→备），仅使用后台私有配置的模型地址和密钥；主备均未配置或均不可用时转人工。
- **hybrid（规则优先、模型兜底）**：
  1. 最新买家消息 `kind=text` 且**不带 attachments**，并按 rules 的包含匹配命中时，直接用该规则 `reply` 原文，不调用模型；reason 为 `rule:<id>`。
  2. 否则（未命中，或最新消息为图片/卡片，或文字消息带图片附件——即使文字含关键词，也须把图片交模型理解）调用一次模型链（主→备）。同一次请求附上当前规则列表的 `id`、`contains`、`description`（不附规则 `reply` 原文，也不附其他店铺数据），由模型二选一：返回 `rule_id` 表示买家意思命中该规则，或按店铺提示返回正常的 reply/handoff 决定。
  3. 模型返回的 `rule_id` 必须是本次请求所附规则列表中的 id。命中时后台生成以该规则 `reply` **原文**为回复内容的 reply 决定（模型不得改写），由前台按发送许可流程执行发送；reason 为 `rule_semantic:<id>`。
  4. `rule_id` 不在列表中时不得使用任何规则回复：若同一输出另含合法的 reply/handoff 决定，按该决定处理（reason 为模型来源）；否则视为模型输出无效，按主备策略换备用，均失败转人工。
  5. 模型生成的决定 reason 为 `model:<slot>:…`，与模型模式相同；主备均未配置或均不可用时转人工。
- 新店铺默认 disabled + rules。切换模式属于设置修改：后台增加 version，旧未发送决定失效。模式与规则是后台设置，客户端协议字段不变。

新店铺默认 disabled，开启只作用 Claw-Next，不代表其他自动回复工具已停止。

## 后台模型配置（仅管理员，不改变客户端协议）

- `GET /api/v1/admin/model` 返回 `version` 与 `primary`、`backup` 两套配置。每套只包含 `base_url`、`model`、`timeout_seconds`、`key_configured`；不会返回密钥或环境变量名。
- `PUT /api/v1/admin/model` 提交以下结构；成功返回公开配置与递增版本：

```json
{"version":0,"primary":{"base_url":"http://127.0.0.1:1234/v1","model":"your-local-model","timeout_seconds":20,"api_key":"","clear_key":false},"backup":{"base_url":"https://api.deepseek.com/v1","model":"your-deepseek-model","timeout_seconds":20,"api_key":"<private-key>","clear_key":false}}
```

- 主模型优先，连接失败、超时、HTTP 错误、不可用响应才尝试备用模型一次。有效的 `handoff` 决定不会触发备用；两套均不可用则转人工。每次新判断重新从主模型开始。决策 `reason` 标记实际模型槽位及切换原因，不改变客户端字段或发送流程。
- 云端地址要求 HTTPS；本地 `localhost`、回环或私有 IP 可用 HTTP。地址不得包含用户名、密码、查询参数或片段，不跟随重定向；服务端追加 `/chat/completions`。地址最多 2048 字符，模型名最多 128 字符，超时为 1–60 秒整数。每套地址和模型同时为空表示停用该套。
- `api_key` 留空或省略保留已有密钥，`clear_key:true` 明确清除；不能同时清除并提交非空密钥。本地无密钥服务可直接调用。密钥保存在后台私有数据目录的数据库中，禁止提交 Git、公开分享或把数据目录当作静态文件目录。
- 旧单模型配置自动映射为主模型，旧格式 PUT 仍可更新主模型。原有主模型环境变量密钥兼容；明确清除密钥或更换主模型地址后，不再自动套用旧环境密钥。旧 `version` 保存返回 409 `model_config_changed`。保存使旧判断不能领取新发送许可；`unknown` 不变。
- `POST /api/v1/admin/model/test` 提交 `{"slot":"primary","version":1}`（或 `backup`），对该版本已保存配置实际请求一次无业务内容的 completion，不调用备用、不创建业务事件。返回 `{"slot":"primary","version":1,"ok":true,"reason":"ok","latency_ms":123}`；失败仅返回安全错误类别，不返回模型原文。未登录拒绝，旧版本返回 409。请求期间配置变化则结果标为过期。测试通过表示该配置能够返回 completion，不等于真实客服效果验收。
- 管理页先保存再测试；编辑、保存、退出后旧测试结果作废。配置保存并不执行模型请求；主动连接测试、主动提示词草稿生成、模型模式中的新业务判断、混合模式中未被规则直接命中的新业务判断会调用服务。规则模式的业务判断不调用模型；草稿生成只使用主模型，不套用业务判断的主备切换策略。
- 管理页每 5 秒刷新店铺心跳，仅表示客户端已连接后台。有效租约不等于平台已登录；本协议尚无平台登录验证状态上报字段。

### 管理员提示词草稿

此接口是新增管理能力，是否可用以部署版本为准；旧后台可返回 404，调用方不得因此尝试客户端业务接口或自动开启回复。客户端身份、心跳、事件、租约、claim、回执和协议版本 1.0 不变。

`POST /api/v1/admin/prompt-draft`，已完成首次改密的管理员 Bearer，JSON 只允许下列三个字段：

```json
{"shop_id":"demo-shop","brief":"虚构示例：材质未确认时先询问款式或转人工。安装和退换条件待确认，不承诺。","version":1}
```

- `shop_id` 必须满足通用 ID 格式并已登记；此字段只用于检查目标店铺和绑定草稿，不读取该店铺已有提示词、规则、聊天或商品资料作为生成内容。
- `brief` 为字符串，去掉首尾空白后长度为 1–4000 个字符。仅发送该内容及后台固定的整理要求给已保存的主模型；输入属于待整理资料，不授予执行操作的权限。管理员不应输入密钥或买家私人信息。
- `version` 为非负整数（布尔不算整数），必须等于 `GET /api/v1/admin/model` 的配置版本，**不是店铺设置版本**。请求不能指定模型、地址、密钥或备用策略。
- 每次主动请求只调用主模型一次；未配置、失败、响应格式错误或截断时不尝试备用模型。单次网络等待上限 45 秒，只用于此次生成，不修改已保存的回复超时或模型配置；它不承诺从点击到完成的总耗时一定小于 45 秒。
- 全后台最多同时执行一份草稿生成；繁忙直接拒绝，不排队。退出登录、修改密码和配置操作不会等待该模型请求结束。关闭页面或切换店铺只丢弃旧结果，不保证立即取消正在进行的模型调用。

成功 200：

```json
{"shop_id":"demo-shop","version":1,"draft":"材质待确认时先询问款式或转人工。安装与退换条件未确认，不作承诺。"}
```

`draft` 为去掉首尾空白后的 1–8000 字符纯文本；模型返回截断标记时不交付部分草稿。输出仍是未核实的模型内容，不保证业务事实正确。管理页只作为可编辑文字展示，禁止按 HTML 执行；必须由管理员明确确认替换提示词，再通过原设置接口保存，才应用到该店铺。生成与替换都不自动保存、不改店铺开关、判断方式、规则或模型配置，不创建事件、发送许可或回执，不发送消息。店铺处于关闭或规则方式时也可主动生成草稿，但不会因此启用模型业务判断。

错误沿用统一错误对象：

| 情形 | HTTP / code | 行为 |
|---|---|---|
| 未登录、会话过期或生成期间会话被撤销 | 401 `unauthorized` | 不返回草稿；首次校验失败不调用模型 |
| 客户端身份 / 管理员仍需首次改密 | 403 `admin_required` / `admin_password_change_required` | 调用模型前拒绝 |
| 字段集合或版本类型错误 / brief 错误 / ID 错误 | 400 `invalid_prompt_draft` / `invalid_prompt_brief` / `invalid_shop_id` | 不调用模型 |
| 店铺未登记 | 404 `shop_not_found` | 不调用模型 |
| 模型版本不匹配，或生成期间模型配置改变 | 409 `model_config_changed` | 首次校验失败不调用模型；晚到结果丢弃 |
| 已有草稿生成正在执行 | 429 `prompt_draft_busy` | 不创建第二个模型调用 |
| 主模型未配置、请求失败、输出为空/过长/格式错误/截断 | 502 `prompt_draft_unavailable` | 不回显上游正文或凭据，不调用备用，不写设置 |

返回草稿前再次检查管理员会话和模型版本；任何失败都释放并发名额。界面必须绑定发起时的会话、店铺和请求序号，切换店铺、退出或重置后不能应用旧结果。相同请求再次提交是新的模型调用，可能产生费用；失败不得自动重试。验收至少覆盖权限、首次改密、输入边界、仅主模型、无设置/事件写入、并发拒绝、生成中退出/改模型版本和跨店旧结果丢弃。

## 非本版本能力

前台已有拼多多平台适配：每店独立平台工作台登录、店铺身份交叉核验、被动读取平台页面自身加载的会话与订单数据、经核验的单次点击发送，多店各自隔离、可在界面切换。以下仍不在本版本内：订单/售后的主动实时查询（只有前台从页面被动读取、随上下文附带的只读订单摘要）、备注/库存写入、自动转接执行（handoff 只是建议）、云端托管资源。管理界面仅管理本项目。

实现、测试通过、进程启动、平台确认与真实业务验收是不同证据。正式接管店铺前须逐店完成线上验收；不能凭模拟或虚构数据测试宣称已完成实盘迁移。

## 契约 A：事件预算、未领取事件取消与响应计时

状态：**前后台已实现，按心跳能力协商启用**。`protocol_version` 仍为 `1.0`。客户端在心跳中声明 `reply_deadline`，后台确认后，客户端才为新事件提交预算或调用取消接口。代码实现不等于测试通过、部署完成或真实业务验收；这些状态应分别核对。旧客户端、未确认能力或缺省预算的事件保持既有行为；预算与取消相关的扩展情形按本节规定处理。`send_item` 保持独立协商，原发送许可、回执与 unknown 保护不变。

示例全部为虚构数据。

### A.1. 范围与不变量

本扩展只增加可协商的事件预算、未领取事件取消和响应计时；不包含 SSE、客户端状态上报、模型主备预算比例或忙时溢出策略。

- 首次观察后 20 秒限制的是**开始平台发送**；已开始的发送继续按现有许可和回执规则结束。
- 前台用本地单调时钟执行最后拒发检查；重启按持久记录恢复。后台无法补偿网络传输，也不能替代该检查。
- `decision.expires_at` 的 60 秒回复有效期、`claim_expires_at` 的 10 秒许可及本扩展预算保持不同含义。
- `unknown` 永久保留、不重试、不改写；未领取事件不制造 attempt 或回执；放弃仅作用于本事件，不增加买家锁。
- Bearer、店铺隔离、原客户端归属、最新消息、版本、设置与租约检查继续有效。`send_item` 仍单独协商。

### A.2. 能力协商

沿用现行心跳 `capabilities` 的校验与交集规则，新增独立能力名 `reply_deadline`，不与 `send_item` 绑定。

客户端只有在最近一次成功心跳确认本 instance/session/generation 的该能力后，才在新事件中发送预算或调用取消接口。租约变化必须重新确认；无能力字段视为未确认。旧后台不返回此能力时，新客户端只执行本地时效，不试探性发送新字段。租约已失效时不提交新事件，也不通过去掉预算字段降级绕过租约。

未经确认首次提交预算返回 400 `capability_not_confirmed`；未经确认首次取消返回 409 同名代码。对原客户端已有事件，先核对请求摘要：原样重投仍返回原记录，不重新判断能力/租约；不同请求体仍为 `event_conflict`。未曾受理的请求须满足当前能力/租约，前台不可换 event_id 或去掉预算来规避。撤回能力只阻止新的首次扩展请求，**不得延长已经受理的预算、复活已终止事件或改变已领取尝试**。已成功取消的重试按下文幂等规则处理。

两处同名能力错误使用不同 HTTP 状态码是有意约定：首次提交的新字段校验使用 400，取消操作的状态条件冲突使用 409；前台均按确定结论处理，不重试。若能力在请求体冻结后、首次受理前撤回，前台保留原请求体，收到 400 后将该事件记为被拒、消息显示“本条待人工”，不换 event_id、不删预算重投，也不锁住整个买家。

### A.3. 提交预算（可选）

`POST /api/v1/events` 顶层增加 `remaining_budget_ms`：整数，范围 0–20000。布尔、浮点、字符串、null、非有限值及越界均为 400 `invalid_remaining_budget`；未创建事件。字段缺省保持旧行为，不强加后台 20 秒截止。

- 前台准备完成后、首次持久化待提交请求体前，用单调时钟计算剩余毫秒，向下取整并限制在 0–20000，再固定原请求体；之后重投不重新计算。同 event_id、同请求体仍幂等；改变预算属于 `event_conflict`，不能刷新截止。
- 后台首次受理时以本机单调时钟建立截止，覆盖排队、主备调用、解析及就绪等待。模型调用只分得尚存预算，不把各槽 timeout 简单相加。
- 预算冻结到后台首次受理之间的传输或重投耗时不会从冻结值再次扣除，因此后台截止可能晚于前台本地截止；这是保持原体幂等的明确取舍。前台本地过期后停止重投，并继续在申请许可前、许可返回后、点击前拒绝过期发送，不能据此延长本地 20 秒。
- 向下取整后为 0 也按以下规则处理，不先尝试一次模型。0 合法：在受理事务内直接持久化终态，202 返回 `state=ready`、`decision={action:handoff,text:"",reason:reply_deadline_exceeded,expires_at:受理墙钟秒}`、`delivery.status=unclaimed`、`attempt_id=null`；不进入 pending、不启动模型。
- 预算不可通过轮询、续租、重投、设置更新、取消或 claim 延长。字段缺省的旧式事件仍遵守原契约。

### A.4. 截止的响应与执行

预算事件的快照可增加 `event_deadline`，类型为有限 Unix 秒数字：`accepted_wall_s + remaining_budget_ms / 1000`，用于诊断及重启恢复。旧式事件省略此字段。它不是客户端或平台的发送许可；前台不按服务器墙钟替换本地单调截止。

可发送 ready 指 `state=ready`、`decision.action` 为 reply/send_item、delivery=unclaimed 且无 attempt；handoff/none 不属于该集合。后台在出队、调用模型前、主备切换、结果提交和 claim 事务内核对预算。到期且尚无 attempt 的 pending/processing/可发送 ready 事件原子结束为 `ready + handoff`、`reason=reply_deadline_exceeded`，文本为空，delivery 保持 unclaimed。归属以事件首次受理的持久记录为准，并与本次请求身份比较；请求字段不能覆盖原归属。所有因截止终止的事件（含初始预算为 0）都不能 claim；校验原归属及既有 attempt 后，对此终态返回 409 `reply_deadline_exceeded`。其他首次 claim 保留租约/版本等核验，并在 decision 有效期前检查事件预算；已领取 attempt 的重复 claim 查询保持原规则，不重新判断本扩展预算、不延长许可。

终止后记录不可再被模型晚返回、重启重判或设置变化覆盖。若其他终止原因已先提交（如 superseded），不改写该原因。无需仅靠客户端及时发 cancel 才停止无用判断；实现须有有界的超时处理，不无限开线程。

前台收到 `ready + handoff` 且 `reason=reply_deadline_exceeded`，或 claim 返回 409 `reply_deadline_exceeded` 时，显示“本条待人工”，不重试该条、不增加买家接管锁；同一买家后续新消息照常处理。

**若 claim 已先成功**，后台截止不改变该 attempt，也不阻止按原许可提交回执。前台仍检查自己的发送开始截止：确定未开始则用已有 attempt 上报 not_sent；已开始则不因本预算到期中断，但仍受原有 claim 许可、平台确认等待与回执规则约束；超时仍 unknown，绝不重发。

### A.5. 取消未领取事件

`POST /api/v1/events/{event_id}/cancel`，客户端 Bearer，JSON：

```json
{"instance_id":"instance-001","session_id":"session-001","generation":1,"reason":"reply_deadline_exceeded"}
```

取消重试必须保留原请求的四字段值，不追加诊断字段或改写归属。请求只接受以上四字段；reason 为固定枚举 `reply_deadline_exceeded`，不接收自由文本；格式错误返回 400。既有 token 的 shop/client 是权限来源，不能通过请求指定或切换。

校验顺序与结果：

1. 非原 shop/client：404，不泄露事件；instance/session/generation 必须匹配原事件，否则 409 `cancel_owner_mismatch`。
2. 同一归属已经因截止终止且仍无 attempt：200 返回当前终态，不改时间、不制造记录；此只读式幂等重试无需重新取得租约或能力。
3. 其他首次取消须已确认能力、当前有效租约，错误沿用心跳/claim 的租约代码。仅 pending、processing、可发送 ready 且 delivery=unclaimed、无 attempt 可取消；已 superseded 或其他终态返回 409 `cancel_not_allowed`。
4. 已 claimed、sent、not_sent、unknown 或任何已有 attempt：409 `cancel_not_allowed`，不得清除尝试或核查记录。首次取消依次核对归属、能力、租约、可取消状态。
5. 成功 200：原子结束为 `state=ready`、`decision={action:handoff,text:"",reason:reply_deadline_exceeded,expires_at:终止墙钟秒}`，delivery=unclaimed、attempt_id=null。不新增 delivery 状态，不伪造回执。后台内部保存不可复活的终止标记，快照沿用既有结构。

新 instance/session 不得首次取消旧归属事件；旧事件由后台截止或原 superseded 规则结束。已成功取消的请求若跨重启重试，必须保留原请求中的归属字段，只能读取同一终态，不能换成新身份申请取消。

**双方已确认的重启恢复规则：** 发出 cancel 前持久化的意图记录只证明曾计划发起，不能证明请求已到后台或取消已成功。重启后的新 instance 对这类记录先查询事件快照；只有确认同一事件已经因截止终止、无 attempt 时，才可按原四字段执行只读式幂等重试。未确认该终态、请求失败或仍为可取消状态时，不以旧意图记录发起 cancel，交由后台截止或原 superseded 规则处理。已 claimed 或 unknown 始终不取消、不重放。

前台本地超时且确认能力、仍有原租约、无 attempt 时，尽力调用 cancel；网络失败只允许原样有限重试，不延长本地截止、不伪造后台终态。无能力或无租约时只记本地放弃。后台预算到期不依赖 cancel 成功；取消可以用于符合以上条件的旧式事件；是否取消由前台本地截止决定，不以服务器墙钟证明客户端过期。它只能让已授权的原发送者放弃自己的事件，不能扩大发送权限。

### A.6. 竞态与重启

- cancel/到期处理先提交：后来的 claim 被拒绝，无 attempt。
- claim 先提交：cancel/到期处理不得改写 delivery；客户端按既有 not_sent/unknown 规则结束。事务内校验与写入不可分离。
- 模型完成提交必须再次核对事件可写状态、预算、设置、版本与原租约；失效结果丢弃。网络调用不持有数据库锁。
- 重启不持久复用进程内单调时钟值。预算事件原子保存首次受理墙钟、原预算、墙钟截止及最近的可信墙钟检查点；恢复时先验证记录一致性。
- 在本机墙钟可信的前提下，用截止减当前墙钟恢复剩余值，且不得超过原预算。缺失、非有限、相互矛盾或当前墙钟早于已保存检查点时，对尚未领取的预算事件保守按过期结束。
- 仅凭墙钟无法证明所有跨重启的校时历史；不得声称能检测任意幅度的回拨。若部署环境不能保证墙钟可信，预算事件恢复时直接保守过期。
- 现行重启规则优先保护发送：后台恢复未完成 claim 时归 unknown；已有 unknown、sent 等结果不变。前台只有持久日志证明未调用平台时才可按原规则报告 not_sent，后台已有 unknown 仍优先保留，不能被该回执覆盖。旧式事件不因缺少预算记录被误判过期；预算事件同身份重判也不刷新已存在的预算。

### A.7. 后台计时（仅响应）

事件查询及其他快照响应可增加 `timing` 对象；客户端不得提交同名请求字段；事件提交和新增 cancel 请求携带 timing 返回 400 `invalid_field`，不扩展既有 claim/receipt 的未知字段校验策略。未发生或无法测量的字段省略，不能编造为 0。实际测得 0 毫秒合法；所有耗时为有限非负整数，布尔不充当数字。

| 字段 | 含义 |
|---|---|
| queue_wait_ms | 受理至开始判断；开始后提供，不含模型调用 |
| decision_ms | 开始判断至判定完成，含主备调用与解析，不含排队 |
| primary_ms / backup_ms | 实际尝试对应槽的耗时，未尝试则省略 |
| model_slot | 成功产出判断的 primary 或 backup；规则或全失败省略 |
| fallback_used | 判断结束后给出布尔值，表示是否实际尝试备用，不限于成功 |
| failure_class | 最终失败的固定分类；成功省略 |

取消与自动到期竞态时，以先提交终态者确定 failure_class（cancelled 或 deadline_exceeded），之后不可改写。failure_class 固定为：`deadline_exceeded`、`cancelled`、`model_unavailable`、`model_invalid_output`、`internal_error`。取消/截止终态若判断尚未开始，不伪造 decision_ms。规则未命中是正常 handoff，不作为模型失败。模型晚返回不得更改已终止快照的计时。

不返回异常原文、地址、密钥、提示词、买家文本或模型回复。decision_ms 已包含 primary_ms/backup_ms，前台将其与自身等待后台时间分列，不相加重复计账；旧后台缺失时显示明细不可用。计时不参与发送授权。

`timing` 为可选诊断对象。已知字段的类型、数值或枚举不合法，或 timing 本身不是对象时，前台忽略整个 timing 并按明细不可用处理；不因此拒绝整个事件快照，不把不合法值记作 0。未知 timing 字段忽略以保留前向兼容。此宽容规则不适用于身份、归属、decision、delivery 等授权字段，它们仍须按现行契约严格校验。

### A.8. 兼容与验收矩阵

| 场景 | 必须验证 |
|---|---|
| 旧前台 / 旧后台 | 原契约行为不变 |
| 新前台 / 旧后台 | 能力未确认，不发送新字段或 cancel；本地拒发继续有效 |
| 旧前台 / 新后台 | 缺省预算保持原行为；未知响应字段不破坏解析 |
| 新前台 / 新后台 | 能力确认后才启用；撤回不复活已有预算事件 |
| 缺省、0、20000、20001、null、true、浮点预算 | 旧行为、立即终止、接受、其余 400；失败不落事件 |
| 重投相同/不同预算 | 原样返回原事件 / event_conflict，截止不刷新 |
| 冻结后首次受理前撤回能力、提交重投耗时 | 400 确定拒绝且不改体绕过；后台截止可能较晚但前台本地截止不变 |
| 排队中/模型中/ready 未领取到期 | 无新模型调用或新 claim；晚结果不能覆盖终态 |
| cancel 与 claim 并发、取消与模型返回并发 | 恰有一种可发送结论，无 cancelled 与 attempt 混合状态 |
| 不同店铺、client、instance、session、generation | 隔离、拒绝且不改状态 |
| 取消重试、租约到期后重试、服务器自动到期后重试 | 匹配原归属的已终止结果幂等返回，不续期 |
| 重启时仅有 cancel 意图记录、原请求未发出或响应丢失 | 先查终态；未确认截止终态时不发起旧归属的首次取消 |
| 已领取但未开始 / 已开始 / 已 unknown | 原回执规则，不伪造未领取事件的 not_sent，不重放 unknown |
| 重启预算过期、记录损坏、可检测回拨、旧式事件 | 保守恢复；已有预算不刷新；无预算的旧式行为保留 |
| 主成功/备成功/全失败/规则/取消/重启计时 | 字段只在实际测得时出现，枚举与类型明确，无敏感原文 |
| timing 类型、耗时或枚举错误、未知字段 | 错误已知字段使整个 timing 被忽略，快照其他字段照常严格校验；未知字段忽略 |
| 同一买家旧事件取消后新消息 | 新事件正常处理，不被旧事件冻结 |

### A.9. 实施前验收

前台实施与验收须覆盖：独立能力名及撤回规则、未知响应字段兼容、固定预算的原样重投、取消幂等和错误码、仅响应计时、服务器截止不替代最后本地检查。

后台实施与验收须覆盖：到期与 claim/cancel 的原子性、ready 事件截止、旧式兼容、主备整体预算的可终止执行、重启恢复与模型晚返回隔离。具体模型并发数与主备分配继续由虚构/脱敏基准测试决定，本扩展不预设 99% 达标。


### 管理员聊天规则与提示词补充草稿

以下接口仅供已完成首次改密的管理员使用，不扩展客户端协议或发送权限。每次操作都显式发起，失败不自动重试；导入和生成均不写入店铺设置、聊天数据库、事件或发送队列。仅调用已保存的主模型，无备用回退，单次网络等待上限 60 秒；不改变已保存的回复超时。与原提示词草稿接口共用一个并发名额。

**导入预览**：`POST /api/v1/admin/chat-import`，参数严格为 `{shop_id, filename, text}`。文件内容为 UTF-8 JSON/JSONL、CSV 问答列或明确“买家/客服”角色的 TXT。解码后 `text` 的 UTF-8 字节数必须为 1–2097152（2 MiB），超限返回 400 `invalid_chat_import`；这是导入文本限制，不是 HTTP 请求体限制。完整请求经过 JSON 转义、包含字段名和其他参数后另受 8 MiB 请求体上限约束，两项须同时满足。仅处理文本问答，不读取文件路径、链接、附件、图片或其他系统数据。姓名/用户标识等元数据不进入模型，常见联系方式做自动过滤；自动过滤不能保证去除所有个人信息，必须由管理员先核对预览和店铺。上传到后台不等于已经发给模型。

返回 `{shop_id, shop_version, pairs, stats, warnings}`；每个 pair 为 `{id, question, answer, conversation}`，其中 id/conversation 是匿名本次导入编号。抽样/长度等限制须显示给用户：最多选取 200 个问答用于分析，总问答文本不超过 24000 字，不得把样本频次声称为全文件统计。刷新、退出、换店或重新导入后丢弃页面中的导入资料。

**规则草稿**：`POST /api/v1/admin/rule-draft`，参数严格为 `{shop_id, version, shop_version, pairs, existing_rules}`，完整 JSON 请求体上限为 4 MiB；问答、现有规则的数量与文本长度限制仍须分别满足。`version` 是模型配置版本，`shop_version` 是已加载的店铺设置版本；existing_rules 是页面当前待编辑规则，按设置接口约束验证。生成前后均核对会话、店铺版本、模型版本。未确认预览或无有效导入时，页面禁用“一键生成规则”。

返回 `{shop_id, version, shop_version, candidates, warnings}`。candidate 包含 `contains, description, reply, evidence_ids, count, conflicts, warnings`。最多 30 个语义归类后的高频问题，至少来自两个独立来源会话；count 由合法 evidence_ids 对应的匿名会话数计算，不采信模型伪造次数。输出来源必须存在，引用重复/非法来源不得作为合格证据；历史答案是拟定话术的来源，不是现行政策或客观事实的证明。

后台逐条核验草稿：不足两个独立来源、来源编号不存在、重复或与已接受草稿复用、关键词重复、未知冲突编号或字段不合格时，整条剔除并在 warnings 提示剔除数量。不得只删掉错误引用后继续采用该条话术；不合格条目不消耗其他条目的来源编号。保留下来的草稿仍须分别通过全部校验，count 仅按其有效来源的独立会话数计算。所有条目都被剔除时返回空 candidates 和明确提示，不得伪装成已完整覆盖高频问题。整体输出格式不合格、超过30条、顶层警告不合格或输出被截断时仍拒绝整批结果，不自动重试。用于比较的现有规则 JSON 序列化文本最多 32000 字。

模型请求内部可将匿名来源编号映射为连续编号以减少引用错误；返回候选前须还原到导入预览中的原编号，页面展示和证据计数不得混用。编号映射不能使不存在的引用变为有效证据。

历史车型适配结论不能当作固定的通用适配承诺；生成预览须提示按具体车型、年份、版本、安装位置和商品核对资料。识别出此类话术或代为备注、平台转接、收藏/标星等尚不支持的操作承诺时，用保守的核对/人工处理话术替换，并在候选 warnings 明确提示。此保护不能证明语义或业务事实正确，仍须人工核对现行政策与来源；不增加任何平台写入能力。

conflicts 为可能冲突的现有规则 ID（包含关键词比较和模型提示）；不能保证发现所有语义冲突。界面同时显示来源问答和新旧规则，默认跳过或保留现有内容。管理员可编辑草稿、明确选择新增或替换某条规则；替换保留原 ID，替换发送条目为文本前必须提示。多项同时替换同一目标、超过 100 条规则或输入不合法时不得应用。应用只填入表单，仍需独立点击“保存设置”。规则分页每页 10 条，翻页不得丢失编辑内容或改变实际匹配顺序。

**补充合并提示词**：`POST /api/v1/admin/prompt-merge`，参数严格为 `{shop_id, version, shop_version, current_prompt, supplement}`。current_prompt 是页面当前文本（包括尚未保存的编辑），1–8000 字；supplement 为 1–4000 字。用户应看到会把这两段文字交给主模型的说明。

返回 `{shop_id, version, shop_version, draft, changes, conflicts}`。draft 为 1–8000 字，changes/conflicts 各最多 20 条纯文本，每条最多 500 字。模型被要求保留原有事实和限制，将明确补充按主题合并；矛盾要求只列入待核对点，合并草稿默认保留旧要求，管理员可在预览中编辑决定。输出仍可能遗漏或误解，页面须并排显示原文与合并稿；存在冲突时须人工核对确认，才能填回提示词框。填回不自动保存。

通用失败：无权限/初始密码未改为 401/403；输入不符为 400；店铺不存在 404；`shop_settings_changed` 或 `model_config_changed` 为 409；并发占用 `prompt_draft_busy` 为 429；模型无完整合格输出 `assist_unavailable` 为 502。错误不返回上传正文、模型原始响应或凭据。生成中退出、换店、重置、输入改动及版本变化后旧结果不得填回，也不得再次应用已处理的同一批草稿。
