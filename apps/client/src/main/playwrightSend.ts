import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { connectExistingPage } from "./electronPlaywright.js";
import { selectSendControl } from "./scraplingSelector.js";
import type { PageClickResult } from "./pddClick.js";

/** Real send preparation and one click. Confirmation still comes from the platform response. */
export async function clickSendWithPlaywright(wc: WebContents, uid: string, text: string, deadline: number, current: () => string | null,
  clicked: (pressed: boolean) => void, filled: () => void): Promise<PageClickResult> {
  let pressed = false, released = false, active = true;
  let connection: Awaited<ReturnType<typeof connectExistingPage>> | null = null;
  let refusal: string | null = null;
  let verifyAtPress: () => Promise<string | null> = async () => "pdd_send_control_unverified";
  const disconnect = () => connection?.close();
  const nonce = randomUUID();
  const left = () => Math.max(1, Math.min(2000, deadline * 1000 - Date.now() - 1500));
  const blocked = () => refusal ?? (!active ? "pdd_page_changed" : current() ?? (Date.now() / 1000 >= deadline - 1.5 ? "claim_expiring" : null));
  const stop = (reason: string): PageClickResult => ({ status: pressed ? "unknown" : "not_sent", reason });
  let timer: NodeJS.Timeout | undefined;
  try {
    const initial = blocked(); if (initial) return stop(initial);
    const operation = async (): Promise<PageClickResult> => {
      connection = await connectExistingPage(wc, async type => {
        const block = blocked(); if (block) return block;
        if (type === "mousePressed") {
          if (pressed) return "already_attempted";
          refusal = await verifyAtPress();
          const fresh = blocked(); if (fresh) return fresh;
          pressed = true; clicked(true);
        } else if (type === "mouseReleased") {
          if (!pressed || released) return "already_attempted";
          released = true;
        }
        return null;
      });
      const connectedBlock = blocked();
      if (connectedBlock) { connection.close(); return stop(connectedBlock); }
      const page = connection.page;
      const input = page.locator("div.reply-box div.reply-input textarea:visible");
      if (await input.count() !== 1) return stop("pdd_input_missing");
      // Atomic draft check and fill: never replace text that a human entered in the meantime.
      const fill = await input.evaluate((ta, args) => {
        const keys = [...document.querySelectorAll("li.chat-item .chat-item-box.active[data-random]")].map(e => /^([0-9]{1,32})-/.exec(e.getAttribute("data-random") ?? "")?.[1]);
        if (!keys.length || keys.some(k => !k) || new Set(keys).size !== 1 || keys[0] !== args.uid) return "pdd_conversation_changed";
        if (Date.now() >= args.until) return "claim_expiring";
        const el = ta as HTMLTextAreaElement;
        if (el.disabled || el.readOnly || !el.closest("div.reply-box")) return "pdd_input_missing";
        if (el.value.trim()) return "pdd_input_not_empty";
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, args.text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return null;
      }, { uid, text, until: deadline * 1000 - 1500 });
      if (fill) return stop(fill);
      filled();
      const block = blocked(); if (block) return stop(block);
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("div.reply-box .reply-footer *")].some(e => {
        const r = e.getBoundingClientRect();
        return /^(发送|Send)(\(?((Ctrl\+)?Enter|回车)\)?|↵)?$/.test(e.innerText?.replace(/\s+/g, "") ?? "") && getComputedStyle(e).visibility === "visible" && r.width >= 4 && r.height >= 4;
      }), undefined, { timeout: left() });
      const html = await input.evaluate((ta, key) => {
        const box = ta.closest("div.reply-box")!;
        const candidates = [...box.querySelectorAll<HTMLElement>(".reply-footer button, .reply-footer div, .reply-footer span, .reply-footer [role=button]")].filter(e => {
          const r = e.getBoundingClientRect();
          return !!e.innerText?.trim() && getComputedStyle(e).visibility === "visible" && r.width >= 4 && r.height >= 4;
        });
        const explicit = candidates.filter(e => e.matches("div.send-btn, button, [role=button]"));
        const controls = explicit.filter(e => !explicit.some(other => other !== e && e.contains(other)));
        controls.push(...candidates.filter(e => !explicit.some(other => other.contains(e) || e.contains(other)) && !candidates.some(other => other !== e && e.contains(other))));
        if (controls.length > 101) return "";
        const area = document.createElement("div"); area.className = "reply-footer";
        controls.forEach((e, i) => {
          e.setAttribute("data-claw-send-key", `${key}-${i}`);
          const tag = e.tagName.toLowerCase();
          const clone = document.createElement(["button", "div", "span"].includes(tag) ? tag : "div");
          if (e.matches("div.send-btn")) clone.className = "send-btn";
          if (e.getAttribute("role") === "button") clone.setAttribute("role", "button");
          clone.textContent = e.innerText;
          clone.setAttribute("data-claw-candidate", String(i));
          clone.setAttribute("data-claw-send-control", "true");
          clone.querySelectorAll("textarea,input,script,style").forEach(n => n.remove());
          area.append(clone);
        });
        return area.outerHTML;
      }, nonce);
      const selection = await selectSendControl(html, Math.max(1, deadline * 1000 - Date.now() - 1500));
      if ("error" in selection) return stop("pdd_send_control_unverified");
      const button = page.locator(`[data-claw-send-key="${nonce}-${selection.candidate}"]`);
      await button.scrollIntoViewIfNeeded({ timeout: left() });
      const before = blocked(); if (before) return stop(before);
      verifyAtPress = () => input.evaluate((ta, args) => {
        const keys = [...document.querySelectorAll("li.chat-item .chat-item-box.active[data-random]")].map(e => /^([0-9]{1,32})-/.exec(e.getAttribute("data-random") ?? "")?.[1]);
        const target = document.querySelector(`[data-claw-send-key="${args.key}"]`);
        const label = (target as HTMLElement | null)?.innerText?.replace(/\s+/g, "");
        if (!keys.length || !keys.every(k => k === args.uid)) return "pdd_conversation_changed";
        if (Date.now() >= args.until) return "claim_expiring";
        if ((ta as HTMLTextAreaElement).disabled || (ta as HTMLTextAreaElement).readOnly) return "pdd_input_missing";
        if ((ta as HTMLTextAreaElement).value !== args.text) return "pdd_input_mismatch";
        return target?.closest("div.reply-box") === ta.closest("div.reply-box") && /^(发送|Send)(\(?((Ctrl\+)?Enter|回车)\)?|↵)?$/.test(label ?? "") ? null : "pdd_send_control_unverified";
      }, { uid, text, key: `${nonce}-${selection.candidate}`, until: deadline * 1000 - 1500 });
      const valid = await verifyAtPress();
      if (valid) return stop(valid);
      const point = await button.evaluate(el => {
        const node = el as HTMLElement, r = node.getBoundingClientRect();
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
        for (const fy of [0.5, 0.25, 0.75, 0.1, 0.9]) for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
          const x = left + (right - left) * fx, y = top + (bottom - top) * fy;
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === node || node.contains(hit))) return { x: x - r.left - node.clientLeft, y: y - r.top - node.clientTop };
        }
        return null;
      });
      // Playwright handles visibility/stability/hit testing. The transport permits one press only.
      await button.click({ timeout: left(), noWaitAfter: true, ...(point ? { position: point } : {}) });
      return { status: "dispatched" };
    };
    return await Promise.race([operation(), new Promise<PageClickResult>(resolve => {
      timer = setTimeout(() => { active = false; connection?.close(); resolve(stop("claim_expiring")); }, Math.max(1, deadline * 1000 - Date.now() - 1000));
    })]);
  } catch {
    return stop(pressed ? "pdd_playwright_click_uncertain" : blocked() ?? "pdd_send_button_not_ready");
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    disconnect();
  }
}
