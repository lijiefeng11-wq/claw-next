"use strict";

// Views and drafts stay in page memory; server jobs are temporary. Applying a
// draft only edits the existing settings form and never saves it automatically.
window.setupAdminAssist = function (options) {
  const {state, request, onEdit, renderRules, newRuleId, nextUid, validateRules, handleError} = options;
  const ids = ["chat-file", "chat-import", "chat-clear", "chat-status", "chat-preview", "chat-pairs", "chat-confirm",
    "chat-import-progress", "chat-analysis-progress", "chat-shop-name", "chat-shop-select", "chat-analysis-plan", "chat-template-name",
    "rules-generate", "rule-draft-status", "rule-candidates", "rules-apply", "rules-apply-status", "merge-brief", "merge-generate",
    "merge-status", "merge-preview", "merge-before", "merge-result", "merge-notes", "merge-confirm",
    "merge-confirm-label", "merge-apply", "prompt-input"];
  const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  let seq = 0, importing = false, generating = false, merging = false;
  let pairs = [], draft = null, merge = null;
  let reader = null, imported = null, jobs = [], importContext = null;
  const say = (id, text) => {
    el[id].textContent = text;
    if (id === "rule-draft-status" && el["rules-apply-status"]) el["rules-apply-status"].textContent = text;
  };
  const norm = text => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const ruleSnapshot = () => JSON.stringify(state.rules);
  const context = () => ({epoch: state.epoch, token: state.token, shop: state.selectedShopId, version: state.formVersion, seq});
  function current(c) {
    return c.seq === seq && c.epoch === state.epoch && c.token === state.token && c.shop === state.selectedShopId &&
      c.version === state.formVersion && (!state.remoteSettings || state.remoteSettings.version === c.version) &&
      (!c.snapshot || c.snapshot === ruleSnapshot()) &&
      (!Number.isInteger(c.modelVersion) || (!state.model.dirty &&
        !(state.model.loaded && state.model.config && state.model.config.version > c.modelVersion)));
  }
  function error(err, id, c) {
    if (!current(c)) return;
    if (err.status === 401 || err.status === 403) {
      handleError(err, "操作未完成", c.epoch, c.token);
      return;
    }
    const text = err.code === "prompt_draft_busy" ? "已有聊天导入、分析或其他草稿任务正在处理，本次未开始，请等它结束后重试。" :
      err.code === "invalid_encoding" ? "文件不是 UTF-8 编码，请另存为 UTF-8 后重试。文件尚未上传。" :
      ["shop_settings_changed", "model_config_changed"].includes(err.code) ? "设置已改变，请重新加载后生成，旧结果未应用。" :
      err.code === "invalid_chat_import" ? "未能识别有效问答，请查看格式说明。超长、非文字或含联系资料的问答不会被截断采用。" :
      err.code === "chat_import_not_found" ? "导入任务已过期或已清除，请重新导入文件。" :
      err.code === "invalid_rule_context" ? "当前规则内容超出分析要求，请先核对或精简已有规则。已导入的文件仍可保留。" :
      "未能取得完整结果，可能是连接异常、超时或模型输出不合要求。现有设置未改变，请稍后手动重试。";
    say(id, text);
  }
  function node(tag, text, className) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (className) n.className = className;
    return n;
  }
  function field(label, value, limit, rows) {
    const wrap = node("label", undefined, "field");
    wrap.append(node("span", label, "field-label"));
    const input = document.createElement(rows ? "textarea" : "input");
    if (rows) input.rows = rows; else input.type = "text";
    input.value = value; input.maxLength = limit;
    wrap.append(input);
    return {wrap, input};
  }
  function sourceView(list) {
    const box = node("div"), rows = node("div", undefined, "chat-source-rows"), nav = node("div", undefined, "chat-source-pages");
    const previous = node("button", "上一页", "btn btn-ghost btn-sm"), next = node("button", "下一页", "btn btn-ghost btn-sm");
    previous.type = next.type = "button";
    const label = node("span", undefined, "small muted");
    let page = 0;
    function render() {
      rows.replaceChildren();
      list.slice(page * 20, (page + 1) * 20).forEach(p => rows.append(node("div",
        p.id + " · " + (p.count || 1) + " 个来源会话\n问：" + p.question + "\n答：" + p.answer, "assist-source")));
      previous.disabled = page === 0; next.disabled = (page + 1) * 20 >= list.length;
      label.textContent = "第 " + (page + 1) + " / " + Math.max(1, Math.ceil(list.length / 20)) + " 页 · 共 " + list.length + " 组问答";
    }
    previous.addEventListener("click", () => { if (page > 0) { page--; render(); } });
    next.addEventListener("click", () => { if ((page + 1) * 20 < list.length) { page++; render(); } });
    nav.append(previous, label, next); box.append(rows, nav); render();
    return box;
  }
  function progress(id, done, total) {
    const bar = el[id]; bar.hidden = false;
    if (Number.isFinite(total) && total > 0) { bar.max = total; bar.value = done; }
    else bar.removeAttribute("value");
  }
  function batchCount(list) {
    let total = 0, count = 0, chars = 0;
    [...list].sort((a, b) => b.count - a.count || Number(a.id.slice(1)) - Number(b.id.slice(1))).forEach(pair => {
      // Count Unicode code points as the server does, rather than UTF-16 units.
      const size = [...pair.question].length + [...pair.answer].length;
      if (count && (count >= 30 || chars + size > 24000)) { total++; count = 0; chars = 0; }
      count++; chars += size;
    });
    return total + (count ? 1 : 0);
  }
  function cancelJob(job) {
    if (job.cancelled) return;
    job.cancelled = true;
    request(job.path + "/" + encodeURIComponent(job.id), {method: "DELETE", token: job.token}).catch(() => {});
  }
  function readFile(file, c) {
    return new Promise((resolve, reject) => {
      const active = new FileReader(); reader = active;
      active.onprogress = event => {
        if (current(c)) {
          progress("chat-import-progress", event.loaded, event.lengthComputable ? event.total : null);
          say("chat-status", "正在读取文件：" + Math.round(event.loaded / 1024) + " KB…");
        }
      };
      active.onload = () => {
        if (reader === active) reader = null;
        try { resolve(new TextDecoder("utf-8", {fatal: true}).decode(active.result)); }
        catch (_) { reject(Object.assign(new Error("invalid_encoding"), {code: "invalid_encoding"})); }
      };
      active.onerror = active.onabort = () => {
        if (reader === active) reader = null;
        reject(new Error("read_cancelled"));
      };
      active.readAsArrayBuffer(file);
    });
  }
  async function runJob(kind, body, c, update) {
    const path = "/api/v1/admin/" + kind + "/jobs";
    const created = await request(path, {method: "POST", token: c.token, body});
    if (!created || typeof created.job_id !== "string" || !created.job_id) throw new Error("invalid_response");
    const job = {id: created.job_id, path, token: c.token};
    if (!current(c)) { cancelJob(job); return null; }
    jobs.push(job);
    if (created.shop_id !== c.shop || created.shop_version !== c.version) { cancelJob(job); throw new Error("invalid_response"); }
    for (;;) {
      if (!current(c)) { cancelJob(job); return null; }
      let value;
      try { value = await request(path + "/" + encodeURIComponent(job.id), {token: c.token}); }
      catch (err) { cancelJob(job); throw err; }
      if (!current(c)) { cancelJob(job); return null; }
      if (value.job_id !== job.id || value.shop_id !== c.shop || value.shop_version !== c.version ||
          (kind === "rule-draft" && value.version !== c.modelVersion)) throw new Error("invalid_response");
      update(value);
      if (value.status === "completed") return {job, result: value.result};
      if (value.status !== "running") throw Object.assign(new Error("job_failed"), {code: value.error && value.error.code});
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  function clearCandidates(message) {
    draft = null;
    el["rule-candidates"].replaceChildren();
    say("rule-draft-status", message || "");
  }
  function clearMerge(message) {
    merge = null; el["merge-preview"].hidden = true;
    el["merge-before"].value = ""; el["merge-result"].value = "";
    el["merge-notes"].replaceChildren(); el["merge-confirm"].checked = false;
    say("merge-status", message || "");
  }
  function reset(keepFile) {
    const wasBusy = importing || generating;
    seq += 1; importing = false; generating = false; merging = false;
    if (reader) { reader.abort(); reader = null; }
    jobs.forEach(cancelJob); jobs = []; imported = null; importContext = null;
    pairs = []; if (keepFile !== true) el["chat-file"].value = ""; el["chat-confirm"].checked = false;
    el["chat-import-progress"].hidden = true; el["chat-analysis-progress"].hidden = true;
    say("chat-analysis-plan", "");
    el["chat-pairs"].replaceChildren(); el["chat-preview"].hidden = true;
    el["merge-brief"].value = "";
    clearCandidates(); clearMerge(); say("chat-status", wasBusy ? "已停止本页处理；已发出的模型请求可能还在结束中，之后不会再开始下一批。" : "尚未导入聊天记录。"); sync();
  }
  function sync() {
    if (importContext && !current(importContext)) { reset(); return; }
    const shop = (state.shops || []).find(item => item.shop_id === state.selectedShopId);
    say("chat-shop-name", shop ? shop.name : "请先选择店铺");
    const target = document.getElementById("template-name");
    say("chat-template-name", target && target.value.trim() ? target.value.trim() : "未命名模版");
    const select = el["chat-shop-select"], shops = state.shops || [];
    const signature = JSON.stringify(shops.map(item => [item.shop_id, item.name]));
    if (select.dataset.signature !== signature) {
      select.replaceChildren();
      shops.forEach(item => select.append(node("option", item.name)));
      [...select.children].forEach((item, index) => { item.value = shops[index].shop_id; });
      select.dataset.signature = signature;
    }
    select.value = state.selectedShopId || ""; select.disabled = !state.token || !shops.length;
    // Model versions increase on save. The model page may still cache an older
    // version than the fresh config fetched for this draft; only a newer one
    // invalidates it. Do not overwrite the separate model settings form.
    const modelChanged = item => state.model.dirty || (state.model.loaded && state.model.config && state.model.config.version > item.modelVersion);
    if (draft && (!current(draft.context) || draft.snapshot !== ruleSnapshot() || modelChanged(draft))) {
      clearCandidates("规则或店铺设置已改变，请重新生成，避免覆盖刚才的修改。");
    }
    if (merge && (!current(merge.context) || merge.before !== el["prompt-input"].value || merge.brief !== el["merge-brief"].value || modelChanged(merge))) {
      clearMerge("原提示词或补充已改变，请重新生成合并稿。");
    }
    const locked = state.formDisabled || !state.token || !state.selectedShopId;
    const busy = importing || generating || merging;
    el["chat-import"].disabled = locked || busy || !el["chat-file"].files.length;
    el["chat-confirm"].disabled = locked || busy || !pairs.length;
    el["rules-generate"].disabled = locked || busy || state.model.dirty || !pairs.length || !el["chat-confirm"].checked;
    const selected = draft ? draft.items.filter(i => i.choice.value !== "skip").length : 0;
    el["rules-apply"].disabled = locked || busy || !selected;
    say("rules-apply", "把选中的草稿填入话术模版（" + selected + " 条）");
    el["merge-generate"].disabled = locked || busy || state.model.dirty || !el["merge-brief"].value.trim() || !el["prompt-input"].value.trim();
    el["merge-apply"].disabled = locked || busy || !merge || !el["merge-result"].value.trim() ||
      (merge.conflicts.length > 0 && !el["merge-confirm"].checked);
    el["chat-file"].disabled = locked || busy;
    el["merge-brief"].disabled = locked || busy;
    el["rule-candidates"].querySelectorAll("input,textarea,select").forEach(n => { n.disabled = locked || busy; });
    say("rules-generate", generating ? "正在整理问题…" : "一键生成规则");
    say("merge-generate", merging ? "正在生成合并稿…" : "生成合并稿");
  }
  async function model(c) {
    if (state.model.dirty) throw new Error("unsaved_model");
    const config = await request("/api/v1/admin/model", {token: c.token});
    if (!current(c)) return null;
    if (!config || !Number.isInteger(config.version) || !config.primary || !config.primary.base_url || !config.primary.model) {
      throw new Error("missing_model");
    }
    return config;
  }
  el["chat-file"].addEventListener("change", () => {
    reset(true);
    const file = el["chat-file"].files[0];
    say("chat-status", file ? "已选择 " + file.name + "，请点击导入。" : "尚未导入聊天记录。"); sync();
  });
  el["chat-clear"].addEventListener("click", reset);
  el["chat-shop-select"].addEventListener("change", () => {
    if (typeof options.onShopChange === "function") options.onShopChange(el["chat-shop-select"].value);
    sync();
  });
  el["chat-confirm"].addEventListener("change", sync);
  el["chat-import"].addEventListener("click", async () => {
    if (el["chat-import"].disabled) return;
    const file = el["chat-file"].files[0], c = context();
    importContext = c;
    pairs = []; clearCandidates(); el["chat-confirm"].checked = false;
    el["chat-preview"].hidden = true; el["chat-pairs"].replaceChildren();
    if (!file || file.size > 10 * 1024 * 1024 || !/\.(jsonl?|csv|txt)$/i.test(file.name)) {
      say("chat-status", "请选择不超过 10 MB 的 JSON、JSONL、CSV 或 TXT 文件。"); sync(); return;
    }
    importing = true; sync(); progress("chat-import-progress", 0, null); say("chat-status", "正在读取文件…");
    try {
      const text = await readFile(file, c);
      if (!current(c)) return;
      progress("chat-import-progress", 0, null); say("chat-status", "正在上传文件，后台将自动分批整理…");
      const finished = await runJob("chat-import", {shop_id: c.shop, filename: file.name, text}, c, value => {
        progress("chat-import-progress", value.processed_messages, value.total_messages);
        say("chat-status", Number.isInteger(value.total_messages) ?
          "正在整理：" + value.processed_messages + " / " + value.total_messages + " 条消息 · " + value.processed_batches + " / " + value.total_batches + " 批" : "文件已收到，正在识别格式和消息总量…");
      });
      if (!finished || !current(c)) return;
      const data = finished.result;
      if (!data || !Array.isArray(data.pairs) || !data.pairs.length) throw new Error("invalid_response");
      imported = finished.job;
      pairs = data.pairs; el["chat-pairs"].replaceChildren(sourceView(pairs)); el["chat-preview"].hidden = false;
      const planned = batchCount(pairs);
      say("chat-analysis-plan", "将发送全部 " + pairs.length + " 组独立问答，预计 " + planned +
        " 批。每批主模型失败时最多再调用已保存的备用模型一次，总计最多 " + planned * 2 +
        " 次模型请求；使用云端服务时可能产生费用。请确认后再开始。");
      say("chat-status", "导入完成：" + data.stats.messages + " 条消息，" + data.stats.eligible + " 组有效问答；合并 " + data.stats.duplicates + " 组重复后保留 " + pairs.length + " 组，将全部分批分析。" + (data.warnings || []).join(" "));
    } catch (err) { error(err, "chat-status", c); }
    finally { if (c.seq === seq) {
      importing = false;
      if (!current(c)) say("chat-status", "店铺设置已改变，导入结果已丢弃，请重新导入。");
      sync();
    } }
  });
  function conflicts(candidate, keyword) {
    const key = norm(keyword);
    return state.rules.filter(r => candidate.conflicts.includes(r.id) ||
      (key && norm(r.contains) && (key.includes(norm(r.contains)) || norm(r.contains).includes(key))));
  }
  function renderCandidate(candidate, index) {
    const card = node("details", undefined, "assist-candidate"); card.dataset.candidate = String(index);
    const title = "第 " + (index + 1) + " 条 · " + candidate.count + " 个来源会话 · " + candidate.contains;
    const summary = node("summary", title + " · 待核对"); card.append(summary);
    const contains = field("匹配词", candidate.contains, 500), description = field("适用问题说明", candidate.description, 500, 2);
    const reply = field("回复草稿（请核对事实）", candidate.reply, 2000, 4);
    card.append(contains.wrap, description.wrap, reply.wrap);
    const source = node("details"); source.append(node("summary", "查看来源问答"));
    const evidence = new Set(candidate.evidence_ids);
    source.append(sourceView(pairs.filter(p => evidence.has(p.id)))); card.append(source);
    card.append(node("p", candidate.warnings.join("\n"), "field-help"));
    const old = node("div", undefined, "assist-old"); card.append(old);
    const label = node("label", undefined, "field"); label.append(node("span", "如何处理这条草稿", "field-label"));
    const choice = document.createElement("select"); label.append(choice); card.append(label);
    const target = node("p", undefined, "field-help"); card.append(target);
    const update = () => {
      const overlaps = conflicts(candidate, contains.input.value), previous = choice.value;
      old.replaceChildren();
      if (overlaps.length) {
        old.append(node("strong", "疑似重复或冲突，默认保留已有规则"));
        overlaps.forEach(r => old.append(node("p", "现有：" + r.contains + "\n" + (r.description || "") + "\n" + (r.reply || "[发送条目]") + (r.send ? "\n含发送条目：" + r.send.type : ""))));
      } else { old.append(node("span", "模型未列出冲突，不能证明没有冲突；请核对现有规则。")); }
      choice.replaceChildren(new Option("跳过草稿，保留现有规则", "skip"));
      if (!overlaps.length) choice.add(new Option("新增这条规则", "add"));
      state.rules.forEach((r, i) => choice.add(new Option("替换第 " + (i + 1) + " 条：" + r.contains, "replace:" + r.id)));
      if ([...choice.options].some(o => o.value === previous)) choice.value = previous;
      showTarget(); sync();
    };
    function showTarget() {
      summary.textContent = title + (choice.value === "skip" ? " · 待核对" : " · 已选中");
      const selected = state.rules.find(r => "replace:" + r.id === choice.value);
      target.textContent = selected ? "将替换：" + selected.contains + "\n原回复：" + (selected.reply || "[无文字]") +
        (selected.send || selected.handling ? "\n注意：这条原有发送或平台处理方式，替换后会移除原处理方式，改用上面的文字。" : "") : "";
    }
    choice.addEventListener("change", () => { showTarget(); sync(); });
    contains.input.addEventListener("input", update);
    update();
    el["rule-candidates"].append(card);
    return {candidate, contains: contains.input, description: description.input, reply: reply.input, choice};
  }
  el["rules-generate"].addEventListener("click", async () => {
    if (el["rules-generate"].disabled) return;
    const checked = validateRules();
    if (!checked.ok) { say("rule-draft-status", "请先修正已有规则：" + checked.message); return; }
    const c = context(), snapshot = ruleSnapshot();
    c.snapshot = snapshot;
    clearCandidates(); generating = true; sync();
    progress("chat-analysis-progress", 0, null);
    say("rule-draft-status", "正在准备分批分析全部独立问答；主模型失败时尝试已配置的备用 API，不会自动保存。");
    try {
      const config = await model(c);
      if (!config || !current(c)) return;
      c.modelVersion = config.version;
      if (!imported) throw Object.assign(new Error("missing_import"), {code: "chat_import_not_found"});
      const finished = await runJob("rule-draft", {shop_id: c.shop, shop_version: c.version, version: config.version,
        import_job_id: imported.id, existing_rules: checked.value}, c, value => {
        progress("chat-analysis-progress", value.processed_pairs, value.total_pairs);
        say("rule-draft-status", "分批分析：已处理 " + value.processed_pairs + " / " + (value.total_pairs === null ? "待确认" : value.total_pairs) +
          " 组 · " + value.processed_batches + " / " + (value.total_batches === null ? "待确认" : value.total_batches) + " 批" +
          (value.failed_batches ? "；其中 " + value.failed_batches + " 批未完成，最终会明确标注部分结果。" : ""));
      });
      if (!finished || !current(c)) return;
      const data = finished.result;
      if (snapshot !== ruleSnapshot() || state.model.dirty) { say("rule-draft-status", "规则已改动，旧草稿已丢弃，请重新生成。"); return; }
      if (!data || !Array.isArray(data.candidates) || data.candidates.length > 30) throw new Error("invalid_response");
      draft = {context: c, snapshot, modelVersion: config.version, items: []};
      data.candidates.forEach((candidate, index) => { draft.items.push(renderCandidate(candidate, index)); });
      say("rule-draft-status", (data.candidates.length ? "已生成 " + data.candidates.length + " 条草稿，默认跳过。请选择要新增或替换的条目。" : "本次没有可用的规则草稿，没有添加规则。") + (data.warnings || []).join(" "));
    } catch (err) {
      if (current(c)) { clearCandidates(); error(err, "rule-draft-status", c); }
    }
    finally { if (c.seq === seq) {
      generating = false;
      if (!current(c)) say("rule-draft-status", "店铺设置已改变，旧草稿已丢弃，请重新生成。");
      sync();
    } }
  });
  el["rules-apply"].addEventListener("click", () => {
    sync(); if (el["rules-apply"].disabled || !draft) return;
    const next = state.rules.map(r => ({...r})), targets = new Set(), additions = [];
    let changed = 0;
    for (const [itemIndex, item] of draft.items.entries()) {
      const choice = item.choice.value; if (choice === "skip") continue;
      const value = {contains: item.contains.value.trim(), description: item.description.value.trim(), reply: item.reply.value.trim(), send: null, handling: null};
      if (!value.contains || value.contains.length > 500 || value.description.length > 500 || !value.reply || value.reply.length > 2000) {
        say("rule-draft-status", "第 " + (itemIndex + 1) + " 条草稿有空白或过长内容，请修改后再填入。"); return;
      }
      if (choice === "add") {
        if (conflicts(item.candidate, value.contains).length || additions.some(k => k.includes(norm(value.contains)) || norm(value.contains).includes(k))) {
          say("rule-draft-status", "第 " + (itemIndex + 1) + " 条草稿与其他所选草稿或现有规则存在重叠，请改为替换或跳过。"); return;
        }
        additions.push(norm(value.contains)); next.push({...value, uid: nextUid(), id: newRuleId()});
      } else {
        const id = choice.slice(8), index = next.findIndex(r => r.id === id);
        if (index < 0 || targets.has(id)) { say("rule-draft-status", "第 " + (itemIndex + 1) + " 条草稿的替换目标无效或已被其他草稿选中，请重新选择。"); return; }
        targets.add(id); next[index] = {...next[index], ...value};
      }
      changed += 1;
    }
    if (next.length > 100) { say("rule-draft-status", "填入后超过 100 条，请减少新增项或选择替换。"); return; }
    if (!changed) return;
    clearCandidates("已把 " + changed + " 条草稿填入表单，尚未保存。请核对后点击“保存模版”。");
    state.rules = next; state.rulesPage = 0; renderRules(); onEdit(); sync();
    if (typeof options.onApply === "function") options.onApply();
  });
  el["merge-brief"].addEventListener("input", sync);
  el["merge-result"].addEventListener("input", sync);
  el["merge-confirm"].addEventListener("change", sync);
  el["merge-generate"].addEventListener("click", async () => {
    if (el["merge-generate"].disabled) return;
    const c = context(), before = el["prompt-input"].value, brief = el["merge-brief"].value;
    if (!before.trim() || before.length > 8000 || !brief.trim() || brief.length > 4000) return;
    clearMerge(); merging = true; sync(); say("merge-status", "正在合并，单次网络等待最多 60 秒；原提示词保持不变。");
    try {
      const config = await model(c);
      if (!config || !current(c)) return;
      const data = await request("/api/v1/admin/prompt-merge", {method: "POST", token: c.token,
        body: {shop_id: c.shop, shop_version: c.version, version: config.version, current_prompt: before, supplement: brief}});
      if (!current(c)) return;
      if (before !== el["prompt-input"].value || brief !== el["merge-brief"].value || state.model.dirty) { say("merge-status", "输入已修改，旧合并稿已丢弃，请重新生成。"); return; }
      if (data.shop_id !== c.shop || data.shop_version !== c.version || data.version !== config.version || typeof data.draft !== "string" || !data.draft.trim() || data.draft.length > 8000 || !Array.isArray(data.conflicts) || !Array.isArray(data.changes)) throw new Error("invalid_response");
      merge = {context: c, before, brief, modelVersion: config.version, conflicts: data.conflicts};
      el["merge-before"].value = before; el["merge-result"].value = data.draft;
      el["merge-notes"].append(node("strong", "修改说明"));
      data.changes.forEach(s => el["merge-notes"].append(node("p", s)));
      if (data.conflicts.length) el["merge-notes"].append(node("strong", "以下冲突需要你决定"));
      data.conflicts.forEach(s => el["merge-notes"].append(node("p", s)));
      el["merge-confirm-label"].hidden = !data.conflicts.length;
      el["merge-preview"].hidden = false;
      say("merge-status", "合并稿已生成，尚未填入或保存。请对照原文核对遗漏和冲突。");
    } catch (err) {
      if (current(c)) { clearMerge(); error(err, "merge-status", c); }
    }
    finally { if (c.seq === seq) {
      merging = false;
      if (!current(c)) say("merge-status", "店铺设置已改变，旧合并稿已丢弃，请重新生成。");
      sync();
    } }
  });
  el["merge-apply"].addEventListener("click", () => {
    sync(); if (el["merge-apply"].disabled || !merge) return;
    const value = el["merge-result"].value.trim();
    if (!value || value.length > 8000) { say("merge-status", "合并稿需为 1–8000 字。"); return; }
    clearMerge("已填入提示词框，尚未保存。请核对后点击“保存模版”。");
    el["prompt-input"].value = value; onEdit(); sync();
  });
  sync();
  return {reset, sync};
};
