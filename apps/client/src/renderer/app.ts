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
    platform: { logged_in: boolean; identity: { platform_shop_id: string; display_name: string } | null; detail: string; identity_ok: boolean; expected: string; login_expiry?: string };
    lease: { state: string; generation: number; seconds_left: number; detail: string };
    duplicates: number;
    conversations: Conv[];
  };
  type ShopConfig = { shop_id: string; display_name: string; backend_url: string; platform_shop_id: string; adapter: "mock" | "pdd"; mode: string };
  type ShopEntry = { config: ShopConfig; token_set: boolean; admin_grant_set: boolean; admin_grant_supported: boolean; running: boolean; error: string | null; platform: { logged_in: boolean; detail: string; login_expiry?: string; page?: { state: string; gave_up: boolean }; nav?: { on_chat: boolean; can_go_back: boolean } } | null; alert: { level: "error" | "warn"; text: string } | null; view: View | null };
  type Startup = { supported: boolean; platform: string; launch_at_login: boolean; restart_on_crash: boolean; managed: boolean; location_ok?: boolean };
  type UpdateView = { supported: boolean; state: string; current: { run: number; sha: string } | null; candidate: { run: number; sha: string } | null; detail: string };
  type AppState = { app: { secure_storage: boolean; startup?: Startup; update?: UpdateView }; shops: ShopEntry[] };
  type Bridge = { invoke(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: AppState; error?: string }>; onState(cb: (s: AppState) => void): () => void };

  const bridge = (window as unknown as { clawNext: Bridge }).clawNext;

  const ERRORS: Record<string, string> = {
    token_missing: "请先保存本店客户端口令（后台不在本机时需在“高级”里手动填写）",
    pairing_no_grant: "还没填后台快捷登录授权码：请在后台管理页生成授权码，填到“客户端设置”里，再点“连接后台”自动登记本店",
    pairing_unsupported: "后台版本还不支持自动登记店铺：请先更新后台，或在“高级”里手动填写客户端口令",
    pairing_grant_invalid: "后台快捷登录授权码无效或已撤销：请在后台重新生成，并在“客户端设置”里重新填入",
    pairing_conflict: "后台已有冲突的店铺登记（同一编号或口令被其他绑定占用），未做任何修改；请在后台管理页核对，或在“高级”里手动填写口令",
    pairing_reserved: "这个店铺编号在后台有历史记录、暂不能重新登记：请换一个店铺编号新建",
    pairing_rate_limited: "尝试太频繁，后台暂时拒绝了：请稍等一分钟再点“连接后台”",
    pairing_local_only: "后台只接受本机发起的登记，请确认后台地址是本机地址",
    pairing_invalid_request: "登记内容不符合后台要求（店铺编号或名称格式），请检查店铺设置",
    pairing_uncertain: "登记结果不确定（超时或连不上后台）：后台可能已经登记，请稍后再点“连接后台”，客户端会用同一组凭据核对，不会重复登记",
    pairing_rejected: "后台拒绝了登记请求，请查看后台日志或在“高级”里手动填写口令",
    pairing_changed: "登记期间本店被删除或改了后台地址，这次登记已作废、没有连接；请核对店铺设置后重新点“连接后台”",
    pairing_in_progress: "正在后台登记本店，请稍候几秒再修改或删除",
    pairing_stored_invalid: "本机保存的登记凭据读不出来，为避免重复登记已停止：请在“高级”里手动填写口令，或删除本店后重新添加",
    invalid_token: "口令格式不正确（至少 32 位可打印字符，不含空格）",
    invalid_admin_grant: "授权码格式不正确（应为 43 位字母、数字、_ 或 -）",
    admin_target_unsupported: "只有本机根地址（127.0.0.1 / [::1] / localhost，无路径）的后台才能使用快捷登录授权码",
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
    update_not_supported: "只有放在“应用程序”文件夹里的 Mac 正式版本可以检查更新",
    update_not_available: "请先点“检查更新”",
    update_busy: "正在检查或安装更新，请稍候",
    update_app_path_unexpected: "客户端安装位置异常，不能自动更新",
    shop_not_found: "找不到这个店铺，请刷新后重新选择",
    value_required: "请填写回复内容",
    invalid_adapter: "平台类型不正确，请重新选择模拟平台或拼多多",
    invalid_backend_url: "后台地址格式不对，请检查后重新填写",
    invalid_mode: "运行模式只能是仅观察、自动处理或人工接管",
    invalid_on: "人工接管的开关状态不正确，请刷新后重试",
    invalid_kind: "消息类型不正确，只能是文字、图片或卡片",
    invalid_stable_id: "消息编号选项不正确，请刷新后重试",
    invalid_action: "模拟操作名称不正确，请刷新后重试",
    invalid_send_behavior: "模拟平台的发送结果选项不正确，请重新选择",
    invalid_nav_action: "页面操作只能是后退或回到会话",
    invalid_startup_settings: "启动设置格式不对，请刷新后重新勾选",
    invalid_workspace_zoom: "页面缩放比例不正确，请重新选择",
    invalid_workspace_bounds: "平台页面位置或大小不正确，请调整窗口后重试",
    payload_not_object: "请求内容格式不对，请更新客户端或查看日志",
    unknown_channel: "这个操作当前版本不支持，请更新客户端",
  };

  /**
   * 连接后台。本店还没有口令、本店后台没有授权码，而其他已授权店铺只用一个后台时，先问用户是否改用那个后台再登记
   * （用户明确同意才改本店后台地址；不碰已有口令的店铺；多个不同后台时不擅自选择）。
   */
  async function connectShop(entry: ShopEntry) {
    const id = entry.config.shop_id;
    const own = originOf(entry.config.backend_url);
    const granted = grantedOrigins();
    if (!entry.token_set && !entry.admin_grant_set && granted.length === 1 && granted[0] !== own) {
      const target = granted[0];
      if (confirm(`本店的后台地址（${entry.config.backend_url}）还没有快捷登录授权码，其他店铺用的后台是 ${target}。\n\n改用 ${target} 并在那里自动登记本店？`)) {
        const c = entry.config;
        const saved = await call("shop:save", { shop: { shop_id: id, display_name: c.display_name, backend_url: target, platform_shop_id: c.platform_shop_id, adapter: c.adapter } });
        if (!saved) return;
      }
    }
    if (await call("shop:connect", { shop_id: id })) {
      if (!entry.token_set) toast("已连接；本店已在后台登记。新店的自动回复默认关闭，请到后台管理页开启");
    }
  }

  /** 后台地址的 origin（解析失败为 null）。 */
  function originOf(raw: string): string | null {
    try {
      return new URL(raw.trim()).origin;
    } catch {
      return null;
    }
  }

  /** 已填快捷登录授权码的本机后台（去重后的 origin）。 */
  function grantedOrigins(): string[] {
    return [...new Set(state.shops.filter((s) => s.admin_grant_set).map((s) => originOf(s.config.backend_url)).filter((o): o is string => !!o))];
  }

  /**
   * 新增店铺的默认后台地址：当前选中店铺已授权就用它的后台；否则所有已授权店铺若只有一个后台就用它；
   * 有多个不同后台时不擅自选择，退回默认地址由用户填写。
   */
  function defaultBackendUrl(): string {
    const cur = current();
    if (cur?.admin_grant_set) return originOf(cur.config.backend_url) ?? cur.config.backend_url;
    const granted = grantedOrigins();
    return granted.length === 1 ? granted[0] : "http://127.0.0.1:18880";
  }

  /** 本机后台根地址（与主进程 adminLocalTarget 规则一致的简化判断，只决定界面是否尝试自动登记；最终由主进程校验）。 */
  function isLocalBackend(raw: string): boolean {
    try {
      const u = new URL(raw.trim());
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    } catch {
      return false;
    }
  }

  function errorText(code: string | undefined): string {
    if (code && ERRORS[code]) return ERRORS[code];
    if (code?.startsWith("unexpected_field:")) return "请求格式不对（含不认识的字段），请更新客户端或查看日志";
    return `操作失败：${code}`;
  }

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
      toast(errorText(r.error));
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
    // 以页面上实际显示的展开状态为准：点击后 toggle 事件异步触发，若刷新先到，只看变量会把刚展开/收起的设置翻回去。
    const shown = box.querySelector(":scope > details") as HTMLDetailsElement | null;
    if (shown) settingsOpen = shown.open;
    const st = state.app.startup;
    if (!st) {
      box.replaceChildren(renderAdminGrant());
      return;
    }
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
      {
        open: settingsOpen ? true : undefined,
        // 已被刷新替换掉的旧节点迟到的 toggle 事件不再改写状态。
        ontoggle: (e: Event) => {
          const d = e.target as HTMLDetailsElement;
          if (d.isConnected) settingsOpen = d.open;
        },
      },
      h("summary", { text: "客户端设置" }),
      option("开机自启", st.launch_at_login, (v) => save({ launch_at_login: v })),
      option("崩溃后自动重启", st.restart_on_crash, (v) => save({ restart_on_crash: v })),
      h("div", { class: misplaced ? "hint error-text" : "hint", text: note }),
      updateSection(),
      renderAdminGrant(),
    );
    box.replaceChildren(details);
  }

  /** 后台快捷登录授权码：只显示是否已设置，永不回显授权码。 */
  function backendOrigin(raw: string): string {
    try {
      return new URL(raw).origin;
    } catch {
      return raw;
    }
  }

  /** 授权码输入草稿：只在渲染进程内存中，按“店铺 + 后台 origin”区分；普通状态刷新不清空。 */
  let adminGrantDraft: { key: string; value: string; start: number | null; end: number | null } | null = null;
  let adminGrantInputEl: HTMLInputElement | null = null;
  let adminGrantInputKey: string | null = null;

  function renderAdminGrant(): HTMLElement {
    const entry = current() ?? state.shops[0];
    if (!entry) {
      adminGrantDraft = null;
      adminGrantInputEl = null;
      adminGrantInputKey = null;
      return h("div", { class: "admin-grant" }, h("div", { class: "hint", text: "后台快捷登录授权码：请先添加店铺。" }));
    }
    const origin = backendOrigin(entry.config.backend_url);
    const key = `${entry.config.shop_id}\n${origin}`;
    // 切换目标时丢弃旧草稿；同一目标重建前先同步旧输入框内容（包括未触发 input 的粘贴）。
    if (adminGrantDraft && adminGrantDraft.key !== key) adminGrantDraft = null;
    if (adminGrantInputKey !== key) {
      adminGrantInputEl = null;
      adminGrantInputKey = null;
    }
    const previous = adminGrantInputEl && adminGrantInputKey === key ? adminGrantInputEl : null;
    if (previous) {
      adminGrantDraft = { key, value: previous.value, start: previous.selectionStart, end: previous.selectionEnd };
    }
    const hadFocus = !!previous && document.activeElement === previous;
    const draft = adminGrantDraft && adminGrantDraft.key === key ? adminGrantDraft : null;
    const supported = entry.admin_grant_supported;
    const input = h("input", {
      type: "password",
      autocomplete: "off",
      disabled: !supported || !state.app.secure_storage,
      placeholder: entry.admin_grant_set ? "已设置（不会显示）；输入新授权码可替换" : "粘贴后台生成的授权码（43 位）",
      "aria-label": "后台快捷登录授权码",
    }) as HTMLInputElement;
    if (draft) input.value = draft.value;
    adminGrantInputEl = input;
    adminGrantInputKey = key;
    input.addEventListener("input", () => {
      adminGrantDraft = { key, value: input.value, start: input.selectionStart, end: input.selectionEnd };
    });
    const save = async () => {
      if (await call("app:setAdminGrant", { shop_id: entry.config.shop_id, grant: input.value })) {
        input.value = "";
        adminGrantDraft = null;
        adminGrantInputEl = null;
        adminGrantInputKey = null;
        render();
        toast("授权码已保存");
      }
    };
    const clear = async () => {
      if (await call("app:clearAdminGrant", { shop_id: entry.config.shop_id })) {
        input.value = "";
        adminGrantDraft = null;
        adminGrantInputEl = null;
        adminGrantInputKey = null;
        render();
        toast("授权码已清除");
      }
    };
    const hint = supported
      ? `后台快捷登录授权码（${origin}）：${entry.admin_grant_set ? "已设置" : "未设置"}。在后台生成授权码后填到这里，之后点“打开后台管理”可免输密码。`
      : "只有本机根地址（127.0.0.1 / [::1] / localhost，无路径）的后台才能使用快捷登录授权码";
    const box = h(
      "div",
      { class: "admin-grant" },
      h("div", { class: supported ? "hint" : "hint error-text", text: hint }),
      h(
        "div",
        { class: "row" },
        input,
        h("button", { class: "btn", type: "button", text: "保存", disabled: !supported || !state.app.secure_storage, onclick: save }),
        h("button", { class: "btn secondary", type: "button", text: "清除", disabled: !supported || !entry.admin_grant_set, onclick: clear }),
      ),
    );
    if (hadFocus && draft) {
      const start = draft.start ?? input.value.length;
      const end = draft.end ?? input.value.length;
      queueMicrotask(() => {
        if (!input.isConnected) return;
        input.focus();
        input.setSelectionRange(start, end);
      });
    }
    return box;
  }

  /** 检查更新：只在用户点击时检查；安装前再确认一次（主进程弹窗）。 */
  function updateSection() {
    const u = state.app.update;
    if (!u) return null;
    const current = u.current ? `当前版本：构建 ${u.current.run}（${u.current.sha}）` : "当前版本：开发版（没有版本信息）";
    if (!u.supported) return h("div", { class: "hint", text: `${current}。只有放在“应用程序”文件夹里的 Mac 正式版本可以检查更新。` });
    const busy = ["checking", "downloading", "waiting_tasks", "installing", "pending"].includes(u.state);
    return h(
      "div",
      { class: "update-box" },
      h("div", { class: "hint", text: current }),
      h("button", { type: "button", disabled: busy, onclick: () => void call("app:checkUpdate") }, u.state === "checking" ? "正在检查…" : "检查更新"),
      u.state === "available" ? h("button", { type: "button", class: "primary", disabled: busy, onclick: () => void call("app:installUpdate") }, "下载并安装") : null,
      u.detail ? h("div", { class: u.state === "error" || u.state === "pending" ? "hint error-text" : "hint", text: u.detail }) : null,
    );
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
        ["平台连接", "", entry.platform?.logged_in ? "已登录" : "未登录", [entry.platform?.detail ?? (entry.config.adapter === "pdd" ? "可直接打开平台登录窗口" : "需先连接后台"), entry.platform?.login_expiry].filter(Boolean).join("\n")],
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
      ["平台连接", v.platform.logged_in ? "ok" : "warn", v.platform.logged_in ? "已登录" : "未登录", [v.platform.detail, v.platform.login_expiry].filter(Boolean).join("\n")],
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
        : h("button", { class: "btn", type: "button", text: "连接后台", onclick: () => connectShop(entry) }),
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
              if (!r.ok) return toast(errorText(r.error));
              const n = (r.data as unknown as { dismissed?: number } | undefined)?.dismissed ?? 0;
              toast(n ? `已关闭 ${n} 个平台弹窗` : "没有找到可自动关闭的弹窗；剩下的请在页面上手动关闭");
            },
          })
        : h("button", { class: "btn small", type: "button", text: "打开本店工作台 / 登录", onclick: () => call("shop:login", { shop_id: id }) }),
      entry.running
        ? h("button", { class: "btn secondary small", type: "button", text: "断开后台", onclick: () => call("shop:disconnect", { shop_id: id }) })
        : h("button", { class: "btn small", type: "button", text: "连接后台", onclick: () => connectShop(entry) }),
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
    const url = h("input", { type: "url", value: c?.backend_url ?? defaultBackendUrl() }) as HTMLInputElement;
    const pid = h("input", { type: "text", value: c?.platform_shop_id ?? "", placeholder: "平台实际店铺编号，用于登录身份核验" }) as HTMLInputElement;
    const adapter = h("select", {}, h("option", { value: "mock", text: "模拟平台（虚构数据）" }), h("option", { value: "pdd", text: "拼多多（独立平台工作台）" })) as HTMLSelectElement;
    adapter.value = c?.adapter ?? "mock";
    const token = h("input", { type: "password", autocomplete: "off", placeholder: entry?.token_set ? "已保存（••••••••）；输入新口令可替换" : "粘贴本店客户端口令" }) as HTMLInputElement;
    const save = async () => {
      // 自动登记的结果提示（成功或失败原因）；有它时不再用笼统的“已保存”覆盖。
      let note: string | null = null;
      const ok = await call("shop:save", { shop: { shop_id: shopId.value.trim(), display_name: name.value, backend_url: url.value, platform_shop_id: pid.value.trim(), adapter: adapter.value } });
      if (!ok) return;
      const target = shopId.value.trim();
      if (token.value) {
        const saved = await call("shop:setToken", { shop_id: target, token: token.value });
        token.value = "";
        if (!saved) return;
      } else if (!state.shops.find((s) => s.config.shop_id === target)?.token_set && isLocalBackend(url.value)) {
        // 本机后台、没填口令：自动在后台登记本店（#75）。失败只提示，店铺配置已保存；之后点“连接后台”会再核对。
        const r = await bridge.invoke("shop:pair", { shop_id: target });
        if (r.ok && r.data) apply(r.data);
        note = r.ok ? "已保存，并已在后台登记本店。新店的自动回复默认关闭，请到后台管理页开启" : `店铺已保存；${errorText(r.error)}`;
      }
      selected = target;
      // 新加的拼多多店铺直接进入平台工作台。
      if (!entry) workspaceTab = adapter.value === "pdd" ? "platform" : "records";
      editing = null;
      skeletonFor = null;
      toast(note ?? "已保存");
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
      ),
      h("div", { class: "hint", text: "本机后台（http://127.0.0.1 等）：保存时客户端用“客户端设置”里的后台快捷登录授权码，自动在后台登记本店，不用填口令。远程后台必须是 HTTPS，需要在下面“高级”里手动填写客户端口令。" }),
      h(
        "details",
        { class: "advanced", open: !!entry?.token_set && !isLocalBackend(c?.backend_url ?? "") },
        h("summary", { text: "高级：手动填写客户端口令（远程后台或旧版后台）" }),
        h("div", { class: "form-grid" }, ...field("客户端口令", token)),
        h("div", { class: "hint", text: "口令只保存到系统安全存储，界面不会显示原文。不需要模型密钥或后台管理员口令。" }),
      ),
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
    renderAdminButton();
  }

  // 顶栏“打开后台管理”（#63）：用选中店铺对应的本机后台授权码换一次性票据并在浏览器打开，免输后台密码。
  const adminBtn = document.getElementById("open-admin") as HTMLButtonElement;
  let adminBusy = false;
  function renderAdminButton() {
    const usable = state.shops.length > 0;
    adminBtn.disabled = adminBusy || !usable;
    adminBtn.textContent = adminBusy ? "正在打开…" : "打开后台管理 ↗";
    adminBtn.title = usable ? "在浏览器打开后台管理（本机后台填过授权码时免输密码）" : "先添加店铺，才能打开后台";
  }
  adminBtn.addEventListener("click", async () => {
    if (adminBusy) return;
    adminBusy = true;
    renderAdminButton();
    try {
      const r = await bridge.invoke("app:openAdmin", { shop_id: selected });
      const text = (r.data as unknown as { open_admin?: { text?: unknown } } | undefined)?.open_admin?.text;
      toast(r.ok ? (typeof text === "string" ? text : "已在浏览器打开后台管理") : errorText(r.error));
    } catch {
      toast("打开后台管理失败");
    } finally {
      adminBusy = false;
      renderAdminButton();
    }
  });

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
