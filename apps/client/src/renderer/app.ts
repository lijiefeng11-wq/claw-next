// 渲染页面：没有 Node 能力，只通过 window.clawNext 调用主进程中经过校验的动作。
// 所有业务文字都用 textContent 写入，避免把买家消息当作 HTML 执行。
{
  type Status = { label: string; tone: string; reason: string } | null;
  type Msg = { id: string; stable: boolean; role: string; kind: string; content: string; created_at: number; live: boolean; status: Status; decision_text: string | null; event_id: string | null; context_revision: number | null; history_complete: boolean | null };
  type Conv = { conversation_id: string; revision: number; takeover: boolean; unknown: boolean; last_at: number; messages: Msg[] };
  type View = {
    shop_id: string;
    simulated: boolean;
    mode: string;
    instance_id: string;
    session_id: string | null;
    backend: { state: string; detail: string; client_id: string | null };
    platform: { logged_in: boolean; identity: { platform_shop_id: string; display_name: string } | null; detail: string; identity_ok: boolean; expected: string };
    lease: { state: string; generation: number; seconds_left: number; detail: string };
    duplicates: number;
    conversations: Conv[];
  };
  type ShopConfig = { shop_id: string; display_name: string; backend_url: string; platform_shop_id: string; adapter: "mock" | "pdd"; mode: string };
  type ShopEntry = { config: ShopConfig; token_set: boolean; running: boolean; error: string | null; platform: { logged_in: boolean; detail: string; page?: { state: string; gave_up: boolean }; nav?: { on_chat: boolean; can_go_back: boolean } } | null; alert: { level: "error" | "warn"; text: string } | null; view: View | null };
  type Startup = { supported: boolean; platform: string; launch_at_login: boolean; restart_on_crash: boolean; managed: boolean; location_ok?: boolean };
  type AppState = { app: { secure_storage: boolean; startup?: Startup }; shops: ShopEntry[] };
  type Bridge = { invoke(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: AppState; error?: string }>; onState(cb: (s: AppState) => void): () => void };

  const bridge = (window as unknown as { clawNext: Bridge }).clawNext;

  const ERRORS: Record<string, string> = {
    token_missing: "请先保存本店客户端口令",
    invalid_token: "口令格式不正确（至少 32 位可打印字符，不含空格）",
    backend_url_requires_https: "远程后台地址必须使用 HTTPS；只有本机回环地址可用 HTTP",
    backend_url_invalid: "后台地址无效（不能包含账号、查询参数或 # 片段）",
    invalid_shop_id: "店铺编号只能包含字母、数字和 _ . : -",
    invalid_platform_shop_id: "平台店铺编号只能包含字母、数字和 _ . : -",
    invalid_display_name: "请填写店铺名称（不超过 64 字）",
    disconnect_first: "请先断开连接再修改配置",
    shop_identity_immutable: "平台店铺编号和平台类型保存后不能修改；请换一个店铺编号新建",
    shop_id_case_conflict: "已有只差大小写的同名店铺编号，请换一个",
    shop_data_identity_mismatch: "该店铺编号的本地数据属于另一个平台身份，不能复用；请换一个店铺编号",
    shop_not_running: "请先连接后台",
    secure_storage_unavailable: "系统安全存储不可用，无法保存口令",
    not_simulated_shop: "只有模拟店铺可以使用模拟操作",
    invalid_content: "请输入消息内容（不超过 2000 字）",
    invalid_conversation_id: "买家对话编号只能包含字母、数字和 _ . : -",
    conversation_required: "请先选择一个对话",
    platform_window_closed: "本店平台页面未打开",
    pdd_send_busy: "本店正在发送，请稍后再试",
    platform_no_history: "平台页面没有可以后退的记录",
    not_platform_shop: "只有拼多多店铺有平台工作台",
    startup_unsupported: "开机自启与崩溃重启只在打包后的 Mac / Windows 应用中可用",
    startup_apply_failed: "保存启动设置失败，请查看客户端日志",
    startup_needs_applications: "请先把客户端拖到“应用程序”文件夹、从那里打开，再设置开机自启和崩溃重启",
  };

  const MODES: [string, string, string][] = [
    ["observe", "仅观察", "只收消息、取后台判断，不发送"],
    ["auto", "自动处理", "通过全部核验后，按后台原文发送一次"],
    ["manual", "人工接管", "立即阻止本地排队发送，旧判断全部失效"],
  ];

  let state: AppState = { app: { secure_storage: true }, shops: [] };
  let selected: string | null = null;
  let selectedConv: string | null = null;
  let editing: "new" | "existing" | null = null;
  let skeletonFor: string | null = null;

  function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "text") el.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }

  function toast(text: string) {
    const t = document.getElementById("toast") as HTMLElement;
    t.textContent = text;
    t.hidden = false;
    setTimeout(() => (t.hidden = true), 4000);
  }

  // 本机界面偏好（店铺栏收起、平台页面缩放）：只存在本机浏览器存储，读写失败就用默认值。
  function loadPref(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function savePref(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 偏好只是便利，保存失败不影响使用 */
    }
  }

  /** 平台页面可选的缩放比例，须与主进程 PLATFORM_ZOOM_LEVELS 一致（主进程再次校验）。 */
  const ZOOM_LEVELS = [0.67, 0.75, 0.8, 0.9, 1];
  /** 自动适配：平台聊天页约按 1400 像素宽排版时右侧面板才能完整显示；区域不够宽就按比例缩小。 */
  const FIT_WIDTH = 1400;
  let zoomChoice: "auto" | number = (() => {
    const v = Number(loadPref("claw.platformZoom"));
    return ZOOM_LEVELS.includes(v) ? v : "auto";
  })();
  let areaWidth = 0;
  function zoomFor(width: number): number {
    if (zoomChoice !== "auto") return zoomChoice;
    const want = width / FIT_WIDTH;
    return [...ZOOM_LEVELS].reverse().find((z) => z <= want + 0.001) ?? ZOOM_LEVELS[0];
  }
  function setZoom(choice: "auto" | number) {
    zoomChoice = choice;
    savePref("claw.platformZoom", String(choice));
    lastPresentation = "";
    render();
  }

  async function call(channel: string, payload?: unknown): Promise<boolean> {
    const r = await bridge.invoke(channel, payload);
    if (!r.ok) {
      toast(ERRORS[r.error ?? ""] ?? `操作失败：${r.error}`);
      return false;
    }
    if (r.data) apply(r.data);
    return true;
  }

  function current(): ShopEntry | undefined {
    return state.shops.find((s) => s.config.shop_id === selected);
  }

  function time(ts: number) {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  }

  // ---------- 侧栏 ----------

  function renderSidebar() {
    const list = document.getElementById("shop-list") as HTMLElement;
    list.replaceChildren(
      ...state.shops.map((s) => {
        const v = s.view;
        const sub = s.alert ? s.alert.text : !s.running ? "未连接" : `${v?.backend.state === "ok" ? "后台已连接" : "后台未连接"} · ${v?.platform.logged_in ? "平台已登录" : "平台未登录"}`;
        return h(
          "li",
          {},
          h(
            "button",
            { class: `shop-item${s.config.shop_id === selected ? " active" : ""}${s.alert ? ` alert ${s.alert.level}` : ""}`, type: "button", onclick: () => select(s.config.shop_id) },
            h("span", { class: "initial", title: s.config.display_name }, h("span", { class: `dot ${s.alert ? s.alert.level : s.running && v?.backend.state === "ok" && v.platform.logged_in ? "ok" : ""}` }), s.config.display_name.slice(0, 2)),
            h("span", { class: "name" }, s.alert ? h("span", { class: `dot ${s.alert.level}` }) : null, s.config.display_name),
            h("span", { class: "sub", text: `${s.config.adapter === "mock" ? "模拟 · " : ""}${sub}` }),
          ),
        );
      }),
    );
    (document.getElementById("storage-note") as HTMLElement).textContent = state.app.secure_storage ? "口令保存在系统安全存储中。" : "系统安全存储不可用，无法保存口令。";
    renderAppSettings();
  }

  // ---------- 客户端设置：开机自启、崩溃后自动重启 ----------

  /** “客户端设置”的展开状态只由用户决定（默认收起），界面刷新不改变它。 */
  let settingsOpen = false;

  function renderAppSettings() {
    const box = document.getElementById("app-settings") as HTMLElement;
    const st = state.app.startup;
    if (!st) return box.replaceChildren();
    const save = (patch: Partial<Startup>) => void call("app:setStartup", { launch_at_login: st.launch_at_login, restart_on_crash: st.restart_on_crash, ...patch });
    // Mac 上不在“应用程序”文件夹里运行时，程序路径写不进系统任务：不能修改，并说明原因。
    const misplaced = st.supported && st.location_ok === false;
    const option = (label: string, checked: boolean, onchange: (v: boolean) => void) =>
      h("label", { class: "check" }, h("input", { type: "checkbox", checked, disabled: !st.supported || misplaced, onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked) }), label);
    const note = !st.supported
      ? "仅打包后的 Mac / Windows 独立应用可用。"
      : misplaced
        ? "客户端不在“应用程序”文件夹里运行（例如在“下载”里解压后直接打开），退出或重启后这个位置就失效，暂时不能修改这两项。请退出客户端，在访达里把它拖进“应用程序”文件夹，再从那里打开。"
        : `开机自启：登录${st.platform === "win32" ? " Windows" : "系统"}后自动打开客户端。崩溃后自动重启：异常退出后约 30 秒重新打开；正常退出不会重启；5 分钟内最多自动启动 3 次；只勾这一项不会开机启动。重新打开后恢复上次打开着的店铺，运行模式不变。${st.managed ? "当前由系统托管运行：修改的设置在本次正常退出后、下次打开或下次登录时生效。" : ""}`;
    const details = h(
      "details",
      { open: settingsOpen ? true : undefined, ontoggle: (e: Event) => (settingsOpen = (e.target as HTMLDetailsElement).open) },
      h("summary", { text: "客户端设置" }),
      option("开机自启", st.launch_at_login, (v) => save({ launch_at_login: v })),
      option("崩溃后自动重启", st.restart_on_crash, (v) => save({ restart_on_crash: v })),
      h("div", { class: misplaced ? "hint error-text" : "hint", text: note }),
    );
    box.replaceChildren(details);
  }

  let workspaceTab: "platform" | "records" = "records";

  function select(id: string) {
    selected = id;
    workspaceTab = current()?.config.adapter === "pdd" ? "platform" : "records";
    selectedConv = null;
    editing = null;
    skeletonFor = null;
    render();
  }

  // ---------- 详情 ----------

  function statusCard(title: string, tone: "ok" | "warn" | "error" | "", value: string, detail: string) {
    return h("div", { class: "card" }, h("h3", { text: title }), h("div", { class: "value" }, h("span", { class: `dot ${tone}` }), value), h("div", { class: "detail-text", text: detail }));
  }

  type Tone = "ok" | "warn" | "error" | "";
  type StatusItem = [title: string, tone: Tone, value: string, detail: string];

  function statusItems(entry: ShopEntry): StatusItem[] {
    const v = entry.view;
    if (!v) {
      return [
        ["后台连接", "", "未连接", entry.error ?? "点击“连接后台”开始"],
        ["平台连接", "", entry.platform?.logged_in ? "已登录" : "未登录", entry.platform?.detail ?? (entry.config.adapter === "pdd" ? "可直接打开平台登录窗口" : "需先连接后台")],
        ["店铺身份", "", "未核验", `期望平台店铺：${entry.config.platform_shop_id}`],
        ["发送归属", "", "无", "未持有发送归属，不会发送"],
      ];
    }
    const backendTone: Tone = v.backend.state === "ok" ? "ok" : v.backend.state === "connecting" ? "warn" : "error";
    const backendValue = v.backend.state === "ok" ? "已连接" : v.backend.state === "connecting" ? "连接中" : "不可用";
    const identity = v.platform.identity;
    const idTone: Tone = !identity ? "warn" : v.platform.identity_ok ? "ok" : "error";
    const idValue = !identity ? "未核验" : v.platform.identity_ok ? "已核验" : "与配置不符";
    const leaseTone: Tone = v.lease.state === "held" && v.lease.seconds_left > 0 ? "ok" : v.lease.state === "busy" || v.lease.state === "error" ? "error" : "warn";
    const leaseValue = v.lease.state === "held" ? `已持有（第 ${v.lease.generation} 代）` : v.lease.state === "busy" ? "被其他客户端占用" : v.lease.state === "error" ? "异常" : "未持有";
    return [
      ["后台连接", backendTone, backendValue, v.backend.state === "ok" ? `客户端 ${v.backend.client_id} · 协议 1.0` : v.backend.detail],
      ["平台连接", v.platform.logged_in ? "ok" : "warn", v.platform.logged_in ? "已登录" : "未登录", v.platform.detail],
      ["店铺身份", idTone, idValue, identity ? `实际：${identity.display_name}（${identity.platform_shop_id}）\n期望：${v.platform.expected}` : `期望平台店铺：${v.platform.expected}`],
      ["发送归属", leaseTone, leaseValue, v.lease.state === "held" ? `剩余约 ${v.lease.seconds_left} 秒 · 每 15 秒续租` : v.lease.detail],
    ];
  }

  function renderStatus(entry: ShopEntry): HTMLElement {
    return h("div", { class: "status-grid" }, ...statusItems(entry).map(([title, tone, value, detail]) => statusCard(title, tone, value, detail)));
  }

  /** 平台工作台的紧凑状态：一行小标签，详情在悬停提示里。 */
  function renderPills(entry: ShopEntry): HTMLElement {
    const short: Record<string, string> = { 后台连接: "后台", 平台连接: "平台", 店铺身份: "身份", 发送归属: "归属" };
    return h(
      "div",
      { class: "pills" },
      ...statusItems(entry).map(([title, tone, value, detail]) => h("span", { class: `pill ${tone}`, title: `${title}：${value}\n${detail}` }, h("span", { class: `dot ${tone}` }), `${short[title] ?? title} ${value}`)),
    );
  }

  function renderToolbar(entry: ShopEntry): HTMLElement {
    const id = entry.config.shop_id;
    const v = entry.view;
    const mode = v?.mode ?? entry.config.mode;
    return h(
      "div",
      { class: "toolbar" },
      entry.running
        ? h("button", { class: "btn secondary", type: "button", text: "断开后台", onclick: () => call("shop:disconnect", { shop_id: id }) })
        : h("button", { class: "btn", type: "button", text: "连接后台", onclick: () => call("shop:connect", { shop_id: id }) }),
      entry.config.adapter === "pdd"
        ? h("button", { class: "btn", type: "button", text: "打开本店工作台 / 登录", onclick: () => { workspaceTab = "platform"; render(); void call("shop:login", { shop_id: id }); } })
        : entry.running && !v?.platform.logged_in
          ? h("button", { class: "btn", type: "button", text: "模拟平台登录", onclick: () => call("shop:login", { shop_id: id }) })
          : null,
      (entry.platform || (entry.running && v?.platform.logged_in)) ? h("button", { class: "btn secondary", type: "button", text: "退出平台登录", onclick: () => call("shop:logout", { shop_id: id }) }) : null,
      h("span", { class: "mode-note", text: "运行模式：" }),
      modeButtons(entry),
      h("span", { class: "mode-note", text: MODES.find((m) => m[0] === mode)?.[2] ?? "" }),
    );
  }

  /** compact：平台工作台只显示需要处理的提醒，常驻说明放到收发记录页。 */
  function modeButtons(entry: ShopEntry, small = false): HTMLElement {
    const id = entry.config.shop_id;
    const mode = entry.view?.mode ?? entry.config.mode;
    return h(
      "div",
      { class: `segmented${small ? " small" : ""}` },
      ...MODES.map(([m, label, tip]) => h("button", { type: "button", class: mode === m ? "active" : "", title: tip, text: label, onclick: () => call("shop:setMode", { shop_id: id, mode: m }) })),
    );
  }

  /** 平台页面缩放：− / + 手动调整，点中间的比例回到“自动适配”。 */
  function zoomControl(): HTMLElement {
    const current = zoomFor(areaWidth);
    const i = ZOOM_LEVELS.indexOf(current);
    return h(
      "div",
      { class: "zoom", title: "平台页面缩放：页面显示不全时缩小。点中间的比例恢复自动适配。" },
      h("span", { class: "zoom-label", text: "缩放" }),
      h("button", { class: "btn secondary small", type: "button", text: "−", "aria-label": "缩小平台页面", disabled: i <= 0, onclick: () => setZoom(ZOOM_LEVELS[Math.max(0, i - 1)]) }),
      h("button", { class: "btn secondary small zoom-value", type: "button", text: `${zoomChoice === "auto" ? "自动 " : ""}${Math.round(current * 100)}%`, onclick: () => setZoom("auto") }),
      h("button", { class: "btn secondary small", type: "button", text: "+", "aria-label": "放大平台页面", disabled: i >= ZOOM_LEVELS.length - 1, onclick: () => setZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, i + 1)]) }),
    );
  }

  /** 平台工作台的紧凑操作栏：店名、状态、运行模式、页签、缩放与操作挤在一两行内，把空间留给平台页面。 */
  function renderPlatformBar(entry: ShopEntry): HTMLElement {
    const id = entry.config.shop_id;
    const v = entry.view;
    // 平台页面是否真的开着：退出登录、页面关闭后适配器仍在，但状态里没有 page。
    const pageOpen = !!entry.platform?.page;
    // 离开会话页（点进售后、订单等页面）时才显示“后退 / 回到会话”：在会话页后退可能退回登录页。
    const offChat = pageOpen && entry.platform?.nav && !entry.platform.nav.on_chat ? entry.platform.nav : undefined;
    return h(
      "div",
      { class: "pbar" },
      h("div", { class: "pbar-title" }, h("h2", { text: entry.config.display_name }), h("span", { class: "tag real", text: "拼多多" })),
      renderPills(entry),
      modeButtons(entry, true),
      workspaceTabs(entry, true) ?? "",
      // 后退一步，或直接回到会话页（离开会话页时收不到新消息）。
      offChat
        ? h("button", { class: "btn secondary small", type: "button", text: "← 后退", title: "平台页面后退一步", disabled: !offChat.can_go_back, onclick: () => call("shop:platformNav", { shop_id: id, action: "back" }) })
        : null,
      offChat
        ? h("button", { class: "btn small attention", type: "button", text: "回到会话", title: "回到拼多多会话页。离开会话页时收不到新消息，约 30 秒后也会自动返回。", onclick: () => call("shop:platformNav", { shop_id: id, action: "chat" }) })
        : null,
      h("span", { class: "spacer" }),
      zoomControl(),
      pageOpen
        ? h("button", {
            class: "btn secondary small",
            type: "button",
            text: "清理弹窗",
            title: "关闭平台页面上的引导、公告、广告浮层（不会发送消息，涉及协议、处罚的提示留给人工）",
            onclick: async () => {
              const r = await bridge.invoke("shop:dismissPopups", { shop_id: id });
              if (!r.ok) return toast(ERRORS[r.error ?? ""] ?? `操作失败：${r.error}`);
              const n = (r.data as unknown as { dismissed?: number } | undefined)?.dismissed ?? 0;
              toast(n ? `已关闭 ${n} 个平台弹窗` : "没有找到可自动关闭的弹窗；剩下的请在页面上手动关闭");
            },
          })
        : h("button", { class: "btn small", type: "button", text: "打开本店工作台 / 登录", onclick: () => call("shop:login", { shop_id: id }) }),
      entry.running
        ? h("button", { class: "btn secondary small", type: "button", text: "断开后台", onclick: () => call("shop:disconnect", { shop_id: id }) })
        : h("button", { class: "btn small", type: "button", text: "连接后台", onclick: () => call("shop:connect", { shop_id: id }) }),
      pageOpen || (entry.running && v?.platform.logged_in) ? h("button", { class: "btn danger small", type: "button", text: "退出平台登录", onclick: () => call("shop:logout", { shop_id: id }) }) : null,
    );
  }

  function renderBanners(entry: ShopEntry, compact = false): HTMLElement {
    const box = h("div", { class: "banners" });
    if (entry.config.adapter === "mock") box.append(h("div", { class: "banner sim", text: "模拟模式：所有店铺、买家和消息均为虚构数据，“平台确认”来自模拟器，不代表真实平台已发送。" }));
    else if (!compact) box.append(h("div", { class: "banner warn", text: "本店平台页面与其他店铺的登录状态隔离。观察模式只接收数据；开启自动模式后才会执行后台授权的回复。" }));
    if (entry.alert) {
      const id = entry.config.shop_id;
      box.append(
        h(
          "div",
          { class: `banner ${entry.alert.level} with-action` },
          h("span", { text: `${entry.alert.text}：${entry.platform?.detail ?? ""}` }),
          entry.platform?.page
            ? h("button", { class: "btn secondary", type: "button", text: "重新加载平台页", onclick: () => call("shop:reloadPage", { shop_id: id }) })
            : null,
        ),
      );
    }
    const v = entry.view;
    if (v?.backend.state === "error") box.append(h("div", { class: "banner error", text: `后台不可用：${v.backend.detail}。已停止新的自动发送，不会改用本地判断。` }));
    if (v && v.platform.identity && !v.platform.identity_ok) box.append(h("div", { class: "banner error", text: "平台登录的店铺与本店配置不符（疑似串店），已停止提交和发送。" }));
    if (v?.lease.state === "busy") box.append(h("div", { class: "banner error", text: "另一台客户端正持有本店发送归属；本客户端不会发送。" }));
    const unknown = v?.conversations.filter((c) => c.unknown).length ?? 0;
    if (unknown) box.append(h("div", { class: "banner error", text: `有 ${unknown} 个对话存在“结果待核查”的发送：那条回复不会重发，请到平台人工核对；买家的新消息仍会正常处理。` }));
    return box;
  }

  function messageNode(m: Msg): HTMLElement {
    const placeholder = m.kind !== "text";
    const kindLabel = m.kind === "image" ? "图片" : m.kind === "card" ? "卡片" : m.kind === "unsupported" ? "不支持的内容" : "";
    const roleLabel = m.role === "buyer" ? "买家" : m.role === "agent" ? "客服" : "系统";
    return h(
      "div",
      { class: `msg ${m.role}` },
      h("div", { class: `bubble${placeholder ? " placeholder" : ""}`, text: placeholder ? `［${kindLabel}］${m.content}` : m.content }),
      h(
        "div",
        { class: "meta" },
        m.status ? h("span", { class: `chip ${m.status.tone}`, text: m.status.label }) : null,
        `${roleLabel} · ${time(m.created_at)}${m.live ? "" : " · 历史"}${m.stable ? "" : " · 无可靠编号"}`,
        m.context_revision !== null ? ` · 上下文版本 ${m.context_revision}${m.history_complete === false ? "（历史不完整）" : ""}` : "",
        m.status?.reason ? h("div", { text: m.status.reason }) : null,
      ),
      m.decision_text ? h("div", { class: "decision", text: `后台建议回复：${m.decision_text}` }) : null,
    );
  }

  function renderWorkspace(entry: ShopEntry): HTMLElement {
    const v = entry.view;
    const convs = v?.conversations ?? [];
    if (!selectedConv || !convs.some((c) => c.conversation_id === selectedConv)) selectedConv = convs[0]?.conversation_id ?? null;
    const conv = convs.find((c) => c.conversation_id === selectedConv);
    const list = h(
      "div",
      { class: "conv-list" },
      ...(convs.length
        ? convs.map((c) => {
            const last = c.messages[c.messages.length - 1];
            return h(
              "div",
              { class: `conv-item${c.conversation_id === selectedConv ? " active" : ""}`, onclick: () => ((selectedConv = c.conversation_id), render()) },
              h("div", { class: "cid", text: `${c.conversation_id}${c.takeover ? " · 人工接管" : ""}${c.unknown ? " · 待核查" : ""}` }),
              h("div", { class: "preview", text: last ? last.content : "" }),
            );
          })
        : [h("div", { class: "empty", text: entry.running ? "暂无消息" : "连接后显示消息" })]),
    );
    const view = h("div", { class: "conv-view" });
    if (conv) {
      view.append(
        h(
          "div",
          { class: "conv-header" },
          h("span", { class: "title", text: conv.conversation_id }),
          h("span", { class: "mono", text: `上下文版本 ${conv.revision}` }),
          conv.unknown ? h("span", { class: "chip error", text: "结果待核查" }) : null,
          h("button", {
            class: conv.takeover ? "btn secondary" : "btn danger",
            type: "button",
            text: conv.takeover ? "结束人工接管" : "人工接管此对话",
            onclick: () => call("conv:takeover", { shop_id: entry.config.shop_id, conversation_id: conv.conversation_id, on: !conv.takeover }),
          }),
        ),
        h("div", { class: "messages" }, ...conv.messages.map(messageNode)),
      );
    } else view.append(h("div", { class: "empty", text: "选择左侧对话查看" }));
    return h("div", { class: "workspace" }, list, view);
  }

  function field(label: string, input: HTMLElement) {
    return [h("label", { text: label }), input];
  }

  function renderSimulator(entry: ShopEntry): HTMLElement | null {
    if (entry.config.adapter !== "mock") return null;
    const id = entry.config.shop_id;
    const conv = h("input", { type: "text", value: "buyer-demo-001", "aria-label": "买家对话编号" }) as HTMLInputElement;
    const content = h("textarea", { placeholder: "虚构买家消息，例如：营业时间是什么时候？" }) as HTMLTextAreaElement;
    const kind = h("select", {}, h("option", { value: "text", text: "文字" }), h("option", { value: "image", text: "图片（占位）" }), h("option", { value: "card", text: "卡片（占位）" })) as HTMLSelectElement;
    const stable = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
    const behavior = h(
      "select",
      { onchange: () => sim("set_send_behavior", null, behavior.value) },
      h("option", { value: "confirm", text: "平台确认成功" }),
      h("option", { value: "fail_before_call", text: "调用前失败（未发送）" }),
      h("option", { value: "timeout_after_call", text: "调用后超时（结果不确定）" }),
      h("option", { value: "ack_without_id", text: "只有传输确认（结果不确定）" }),
    ) as HTMLSelectElement;
    const agentText = h("input", { type: "text", placeholder: "人工回复内容" }) as HTMLInputElement;
    const sim = (action: string, conversation: string | null, value: string | null = null) => call("sim:action", { shop_id: id, action, conversation_id: conversation, value });
    const target = () => selectedConv ?? conv.value.trim();
    return h(
      "details",
      { class: "panel", open: true },
      h("summary", { text: "模拟器（虚构数据）" }),
      h(
        "div",
        { class: "row" },
        h("span", { text: "对话" }),
        conv,
        h("span", { text: "类型" }),
        kind,
        h("label", {}, stable, " 平台提供可靠消息编号"),
      ),
      content,
      h(
        "div",
        { class: "row" },
        h("button", {
          class: "btn",
          type: "button",
          text: "模拟买家发送",
          onclick: async () => {
            if (await call("sim:message", { shop_id: id, conversation_id: conv.value.trim(), content: content.value, kind: kind.value, stable_id: stable.checked })) {
              selectedConv = conv.value.trim();
              content.value = "";
              render();
            }
          },
        }),
        h("span", { text: "平台发送结果：" }),
        behavior,
      ),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn secondary", type: "button", text: "当前对话重复推送最后一条", onclick: () => sim("redeliver_last", target()) }),
        h("button", { class: "btn secondary", type: "button", text: "切换当前对话历史缺口", onclick: () => sim("toggle_history_gap", target()) }),
        h("button", { class: "btn secondary", type: "button", text: "重连回补历史", onclick: () => sim("replay_history", null) }),
      ),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn secondary", type: "button", text: "登录失效", onclick: () => sim("expire_login", null) }),
        h("button", { class: "btn secondary", type: "button", text: "登录成其他店铺（串店）", onclick: () => sim("login_as_other", null) }),
        h("button", { class: "btn secondary", type: "button", text: "重新登录本店", onclick: () => sim("login_as_expected", null) }),
      ),
      h(
        "div",
        { class: "row" },
        agentText,
        h("button", { class: "btn secondary", type: "button", text: "模拟人工在平台回复", onclick: () => sim("agent_reply", target(), agentText.value) }),
      ),
    );
  }

  function renderSettings(entry: ShopEntry | null): HTMLElement {
    const c = entry?.config;
    const shopId = h("input", { type: "text", value: c?.shop_id ?? "", disabled: !!c, placeholder: "与后台配置一致，例如 demo-shop" }) as HTMLInputElement;
    const name = h("input", { type: "text", value: c?.display_name ?? "" }) as HTMLInputElement;
    const url = h("input", { type: "url", value: c?.backend_url ?? "http://127.0.0.1:18880" }) as HTMLInputElement;
    const pid = h("input", { type: "text", value: c?.platform_shop_id ?? "", placeholder: "平台实际店铺编号，用于登录身份核验" }) as HTMLInputElement;
    const adapter = h("select", {}, h("option", { value: "mock", text: "模拟平台（虚构数据）" }), h("option", { value: "pdd", text: "拼多多（独立平台工作台）" })) as HTMLSelectElement;
    adapter.value = c?.adapter ?? "mock";
    const token = h("input", { type: "password", autocomplete: "off", placeholder: entry?.token_set ? "已保存（••••••••）；输入新口令可替换" : "粘贴本店客户端口令" }) as HTMLInputElement;
    const save = async () => {
      const ok = await call("shop:save", { shop: { shop_id: shopId.value.trim(), display_name: name.value, backend_url: url.value, platform_shop_id: pid.value.trim(), adapter: adapter.value } });
      if (!ok) return;
      const target = shopId.value.trim();
      if (token.value) {
        const saved = await call("shop:setToken", { shop_id: target, token: token.value });
        token.value = "";
        if (!saved) return;
      }
      selected = target;
      // 新加的拼多多店铺直接进入平台工作台。
      if (!entry) workspaceTab = adapter.value === "pdd" ? "platform" : "records";
      editing = null;
      skeletonFor = null;
      toast("已保存");
      render();
    };
    return h(
      "details",
      { class: "panel", open: !entry || editing !== null },
      h("summary", { text: entry ? "店铺设置与口令" : "添加店铺" }),
      h(
        "div",
        { class: "form-grid" },
        ...field("店铺编号", shopId),
        ...field("店铺名称", name),
        ...field("后台地址", url),
        ...field("平台店铺编号", pid),
        ...field("平台适配", adapter),
        ...field("客户端口令", token),
      ),
      h("div", { class: "hint", text: "远程后台必须是 HTTPS；本机开发可用 http://127.0.0.1。口令只保存到系统安全存储，界面不会显示原文。不需要模型密钥或后台管理员口令。" }),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn", type: "button", text: "保存", onclick: save }),
        entry
          ? h("button", {
              class: "btn danger",
              type: "button",
              text: "删除此店铺配置",
              onclick: async () => {
                if (!confirm("删除后本机将不再保存此店铺配置和口令（本地收发记录保留）。继续？")) return;
                if (await call("shop:remove", { shop_id: entry.config.shop_id })) select(state.shops[0]?.config.shop_id ?? "");
              },
            })
          : null,
      ),
    );
  }

  let layoutFrame = 0, lastPresentation = "";
  function syncWorkspace() {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      const area = document.getElementById("platform-area");
      const entry = current();
      const rect = area?.getBoundingClientRect();
      const show = entry?.config.adapter === "pdd" && workspaceTab === "platform" && rect && rect.width > 0 && rect.height > 0;
      if (show && Math.abs(rect.width - areaWidth) >= 1) {
        const before = zoomFor(areaWidth);
        areaWidth = rect.width;
        // 自动适配的比例随区域宽度变化时刷新操作栏上显示的比例。
        if (zoomFor(areaWidth) !== before) queueMicrotask(render);
      }
      const payload = show
        ? { shop_id: entry.config.shop_id, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, zoom: zoomFor(rect.width) }
        : { shop_id: null, bounds: null };
      const key = JSON.stringify(payload);
      if (key === lastPresentation) return;
      lastPresentation = key;
      void bridge.invoke("workspace:present", payload).then((r) => { if (!r.ok) lastPresentation = ""; }).catch(() => { lastPresentation = ""; });
    });
  }
  window.addEventListener("resize", syncWorkspace);
  new ResizeObserver(syncWorkspace).observe(document.getElementById("detail")!);

  function workspaceTabs(entry: ShopEntry, inline = false): HTMLElement | null {
    if (entry.config.adapter !== "pdd") return null;
    const tabs = h("div", { class: `segmented tabs${inline ? " small" : ""}` },
      ...([["platform", "平台工作台"], ["records", "收发记录与设置"]] as const).map(([tab, label]) =>
        h("button", { type: "button", class: workspaceTab === tab ? "active" : "", text: label, onclick: () => { workspaceTab = tab; render(); } })));
    return inline ? tabs : h("div", { class: "toolbar" }, tabs);
  }

  // 动态区域每次刷新；表单与模拟器只在切换店铺时重建，避免打断输入。
  function render() {
    renderSidebar();
    const detail = document.getElementById("detail") as HTMLElement;
    const entry = current();
    const showPlatform = editing !== "new" && entry?.config.adapter === "pdd" && workspaceTab === "platform";
    detail.classList.toggle("platform-mode", showPlatform);
    document.body.classList.toggle("platform-active", showPlatform);
    syncWorkspace();
    const key = editing === "new" ? "__new__" : entry ? entry.config.shop_id + (entry.running ? ":run" : ":stop") : "__none__";
    if (key !== skeletonFor) {
      skeletonFor = key;
      if (editing === "new" || !entry) {
        detail.replaceChildren(
          state.shops.length && editing !== "new" ? h("div", { class: "empty", text: "请选择左侧店铺" }) : h("div", {}, h("h1", { text: "添加店铺" }), renderSettings(null)),
        );
        return;
      }
      detail.replaceChildren(
        h(
          "div",
          { class: "shop-head" },
          h("h1", { text: entry.config.display_name }),
          h("span", { class: "mono", text: `店铺编号 ${entry.config.shop_id}` }),
          entry.config.adapter === "mock" ? h("span", { class: "tag sim", text: "模拟" }) : h("span", { class: "tag real", text: "拼多多" }),
        ),
        h("div", { id: "dyn" }),
        renderSimulator(entry) ?? "",
        renderSettings(entry),
      );
    }
    if (!entry || editing === "new") return;
    const dyn = document.getElementById("dyn");
    if (showPlatform) {
      dyn?.replaceChildren(
        renderPlatformBar(entry),
        renderBanners(entry, true),
        h("div", { id: "platform-area", class: "platform-area" }, h("div", { class: "empty", text: "点击“打开本店工作台 / 登录”载入平台页面。切换店铺不会退出其他店铺。" })),
      );
      return;
    }
    dyn?.replaceChildren(
      renderBanners(entry),
      renderStatus(entry),
      renderToolbar(entry),
      workspaceTabs(entry) ?? "",
      renderWorkspace(entry),
      entry.view ? h("div", { class: "hint", text: `实例 ${entry.view.instance_id} · 平台会话 ${entry.view.session_id ?? "无"} · 已忽略重复推送 ${entry.view.duplicates} 次` }) : "",
    );
  }

  function apply(next: AppState) {
    state = next;
    if (selected && !state.shops.some((s) => s.config.shop_id === selected)) selected = null;
    if (!selected && editing !== "new") selected = state.shops[0]?.config.shop_id ?? null;
    render();
  }

  // 店铺栏可收起成窄条（只显示店名前两个字与状态点），把宽度让给平台页面。
  const layoutEl = document.querySelector(".layout") as HTMLElement;
  const toggle = document.getElementById("sidebar-toggle") as HTMLButtonElement;
  function applySidebar(collapsed: boolean) {
    layoutEl.classList.toggle("collapsed", collapsed);
    toggle.textContent = collapsed ? "»" : "«";
    toggle.title = collapsed ? "展开店铺栏" : "收起店铺栏";
    toggle.setAttribute("aria-label", toggle.title);
  }
  applySidebar(loadPref("claw.sidebarCollapsed") === "1");
  toggle.addEventListener("click", () => {
    const collapsed = !layoutEl.classList.contains("collapsed");
    savePref("claw.sidebarCollapsed", collapsed ? "1" : "0");
    applySidebar(collapsed);
  });

  (document.getElementById("add-shop") as HTMLElement).addEventListener("click", () => {
    editing = "new";
    selected = null;
    skeletonFor = null;
    render();
  });

  bridge.onState(apply);
  void call("state:get");
  setInterval(() => void call("state:get"), 5000);
}
