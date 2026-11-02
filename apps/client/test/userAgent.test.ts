import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeLikeUserAgent } from "../src/core/userAgent.js";

// 虚构的 Electron 默认浏览器标识样例；期望结果与正版 Chrome 的写法一致。
const MAC_ELECTRON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claw-Next-Client/0.1.0 Chrome/140.0.7339.41 Electron/45.0.0 Safari/537.36";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const WIN_ELECTRON = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claw-Next-Client/0.1.0 Chrome/140.0.7339.41 Electron/45.0.0 Safari/537.36";
const WIN_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

test("去掉应用名与 Electron 两段，Chrome 只留主版本号；系统信息与内核段原样保留", () => {
  assert.equal(chromeLikeUserAgent(MAC_ELECTRON), MAC_CHROME);
  assert.equal(chromeLikeUserAgent(WIN_ELECTRON), WIN_CHROME);
});

test("已经是 Chrome 写法时不变（重复调用结果相同）", () => {
  assert.equal(chromeLikeUserAgent(MAC_CHROME), MAC_CHROME);
  assert.equal(chromeLikeUserAgent(chromeLikeUserAgent(WIN_ELECTRON)), WIN_CHROME);
});

test("应用名带空格以外的其他写法、段落顺序不同也能去掉", () => {
  const odd = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Electron/45.0.0 claw-next-client/1.2.3 Chrome/140.0.7339.41 Safari/537.36";
  assert.equal(chromeLikeUserAgent(odd), "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
});

test("没有 Chrome 版本段的异常标识不动，避免改出更奇怪的结果", () => {
  assert.equal(chromeLikeUserAgent("Electron/45.0.0"), "Electron/45.0.0");
  assert.equal(chromeLikeUserAgent(""), "");
});
