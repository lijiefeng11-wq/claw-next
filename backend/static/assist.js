"use strict";

// All imported data and drafts stay in this page's memory. Nothing is saved by
// this module; applying a draft only edits the existing settings form.
window.setupAdminAssist = function (options) {
  const {state, request, onEdit, renderRules, newRuleId, nextUid, validateRules, handleError} = options;
  const ids = ["chat-file", "chat-import", "chat-clear", "chat-status", "chat-preview", "chat-pairs", "chat-confirm",
    "rules-generate", "rule-draft-status", "rule-candidates", "rules-apply", "merge-brief", "merge-generate",
    "merge-status", "merge-preview", "merge-before", "merge-result", "merge-notes", "merge-confirm",
    "merge-confirm-label", "merge-apply", "prompt-input"];
  const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  let seq = 0, importing = false, generating = false, merging = false;
  let pairs = [], draft = null, merge = null;
  const say = (id, text) => { el[id].textContent = text; };
  const norm = text => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const ruleSnapshot = () => JSON.stringify(state.rules);
  const context = () => ({epoch: state.epoch, token: state.token, shop: state.selectedShopId, version: state.formVersion, seq});
  function current(c) {
    return c.seq === seq && c.epoch === state.epoch && c.token === state.token && c.shop === state.selectedShopId &&
      c.version === state.formVersion && (!state.remoteSettings || state.remoteSettings.version === c.version);
  }
  function error(err, id, c) {
    if (!current(c)) return;
    if (err.status === 401 || err.status === 403) {
      handleError(err, "操作未完成", c.epoch, c.token);
      return;
    }
    const text = err.code === "prompt_draft_busy" ? "已有导入或草稿生成任务正在处理，请等它结束后重试。" :
      err.code === "invalid_encoding" ? "文件不是 UTF-8 编码，请另存为 UTF-8 后重试。文件尚未上传。" :
      ["shop_settings_changed", "model_config_changed"].includes(err.code) ? "设置已改变，请重新加载后生成，旧结果未应用。" :
      err.code === "invalid_chat_import" ? "文件格式、问答长度或待分析内容不符合限制，请查看格式说明并减少内容。" :
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
    const box = document.createDocumentFragment();
    list.forEach(p => box.append(node("div", p.id + " · " + p.conversation + "\n问：" + p.question + "\n答：" + p.answer, "assist-source")));
    return box;
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
  function reset() {
    seq += 1; importing = false; generating = false; merging = false;
    pairs = []; el["chat-file"].value = ""; el["chat-confirm"].checked = false;
    el["chat-pairs"].replaceChildren(); el["chat-preview"].hidden = true;
    el["merge-brief"].value = "";
    clearCandidates(); clearMerge(); say("chat-status", "尚未导入聊天记录。"); sync();
  }
  function sync() {
    const modelChanged = item => state.model.dirty || (state.model.loaded && state.model.config && state.model.config.version !== item.modelVersion);
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
    el["rules-apply"].disabled = locked || busy || !draft || !draft.items.some(i => i.choice.value !== "skip");
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
    seq += 1; pairs = []; el["chat-confirm"].checked = false;
    el["chat-preview"].hidden = true; el["chat-pairs"].replaceChildren(); clearCandidates(); clearMerge();
    const file = el["chat-file"].files[0];
    say("chat-status", file ? "已选择 " + file.name + "，请点击导入。" : "尚未导入聊天记录。"); sync();
  });
  el["chat-clear"].addEventListener("click", reset);
  el["chat-confirm"].addEventListener("change", sync);
  el["chat-import"].addEventListener("click", async () => {
    if (el["chat-import"].disabled) return;
    const file = el["chat-file"].files[0], c = context();
    pairs = []; clearCandidates(); el["chat-confirm"].checked = false;
    el["chat-preview"].hidden = true; el["chat-pairs"].replaceChildren();
    if (!file || file.size > 2 * 1024 * 1024 || !/\.(jsonl?|csv|txt)$/i.test(file.name)) {
      say("chat-status", "请选择不超过 2 MB 的 JSON、JSONL、CSV 或 TXT 文件。"); sync(); return;
    }
    importing = true; sync(); say("chat-status", "正在整理问答和遮盖常见联系资料…");
    try {
      const bytes = await file.arrayBuffer();
      let text;
      try { text = new TextDecoder("utf-8", {fatal: true}).decode(bytes); }
      catch (_) { throw Object.assign(new Error("invalid_encoding"), {code: "invalid_encoding"}); }
      if (!current(c)) return;
      const data = await request("/api/v1/admin/chat-import", {method: "POST", token: c.token,
        body: {shop_id: c.shop, filename: file.name, text}});
      if (!current(c)) return;
      if (data.shop_id !== c.shop || data.shop_version !== c.version || !Array.isArray(data.pairs) || !data.pairs.length) throw new Error("invalid_response");
      pairs = data.pairs; el["chat-pairs"].replaceChildren(sourceView(pairs)); el["chat-preview"].hidden = false;
      say("chat-status", "已识别 " + data.stats.eligible + " 个有效问答，本次分析 " + pairs.length + " 个。" + (data.warnings || []).join(" "));
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
    const card = node("article", undefined, "assist-candidate"); card.dataset.candidate = String(index);
    card.append(node("h4", "候选 " + (index + 1) + " · " + candidate.count + " 个来源"));
    const contains = field("匹配词", candidate.contains, 500), description = field("适用问题说明", candidate.description, 500, 2);
    const reply = field("回复草稿（请核对事实）", candidate.reply, 2000, 4);
    card.append(contains.wrap, description.wrap, reply.wrap);
    const source = node("details"); source.append(node("summary", "查看来源问答"));
    source.append(sourceView(pairs.filter(p => candidate.evidence_ids.includes(p.id)))); card.append(source);
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
      const selected = state.rules.find(r => "replace:" + r.id === choice.value);
      target.textContent = selected ? "将替换：" + selected.contains + "\n原回复：" + (selected.reply || "[无文字]") +
        (selected.send ? "\n注意：这条原有发送条目，替换后会移除发送条目，改用上面的文字。" : "") : "";
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
    clearCandidates(); generating = true; sync();
    say("rule-draft-status", "正在使用已保存的主模型整理，单次网络等待最多 60 秒；不会自动保存。");
    try {
      const config = await model(c);
      if (!config || !current(c)) return;
      const data = await request("/api/v1/admin/rule-draft", {method: "POST", token: c.token,
        body: {shop_id: c.shop, shop_version: c.version, version: config.version, pairs, existing_rules: checked.value}});
      if (!current(c)) return;
      if (snapshot !== ruleSnapshot() || state.model.dirty) { say("rule-draft-status", "规则已改动，旧草稿已丢弃，请重新生成。"); return; }
      if (data.shop_id !== c.shop || data.shop_version !== c.version || data.version !== config.version || !Array.isArray(data.candidates) || data.candidates.length > 30) throw new Error("invalid_response");
      draft = {context: c, snapshot, modelVersion: config.version, items: []};
      data.candidates.forEach((candidate, index) => { draft.items.push(renderCandidate(candidate, index)); });
      say("rule-draft-status", data.candidates.length ? "已生成 " + data.candidates.length + " 条草稿，默认跳过。请选择要新增或替换的条目。" + (data.warnings || []).join(" ") : "本次样本中没有找到至少两个独立来源的重复问题，没有添加规则。");
    } catch (err) { clearCandidates(); error(err, "rule-draft-status", c); }
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
    for (const item of draft.items) {
      const choice = item.choice.value; if (choice === "skip") continue;
      const value = {contains: item.contains.value.trim(), description: item.description.value.trim(), reply: item.reply.value.trim(), send: null};
      if (!value.contains || value.contains.length > 500 || value.description.length > 500 || !value.reply || value.reply.length > 2000) {
        say("rule-draft-status", "所选草稿有空白或过长内容，请修改后再填入。"); return;
      }
      if (choice === "add") {
        if (conflicts(item.candidate, value.contains).length || additions.some(k => k.includes(norm(value.contains)) || norm(value.contains).includes(k))) {
          say("rule-draft-status", "所选草稿之间或与现有规则存在重叠，请改为替换或跳过。"); return;
        }
        additions.push(norm(value.contains)); next.push({...value, uid: nextUid(), id: newRuleId()});
      } else {
        const id = choice.slice(8), index = next.findIndex(r => r.id === id);
        if (index < 0 || targets.has(id)) { say("rule-draft-status", "不能让两条草稿同时替换同一规则，请重新选择。"); return; }
        targets.add(id); next[index] = {...next[index], ...value};
      }
      changed += 1;
    }
    if (next.length > 100) { say("rule-draft-status", "填入后超过 100 条，请减少新增项或选择替换。"); return; }
    if (!changed) return;
    clearCandidates("已把 " + changed + " 条草稿填入表单，尚未保存。请核对后点击“保存设置”。");
    state.rules = next; state.rulesPage = 0; renderRules(); onEdit(); sync();
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
    } catch (err) { clearMerge(); error(err, "merge-status", c); }
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
    clearMerge("已填入提示词框，尚未保存。请核对后点击“保存设置”。");
    el["prompt-input"].value = value; onEdit(); sync();
  });
  sync();
  return {reset, sync};
};
