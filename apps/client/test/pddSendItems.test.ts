import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlatformSendOption } from "../src/core/adapter.js";
import { PddSendOptionBook, instructMatches, instructRequestAllowed, instructResponseOk, instructTarget, goodsRequestAllowed, goodsResponseOk, parseRecommendGoods, planGoodsClick, verifyGoodsTarget, judgeItemReceipt, libraryRequestAllowed, optionIdentity, parseGoodsInstruct, parseSyncMessages, parseVideoLibrary, parseVideoRows, planVideoClick, libraryResponseOk, sentItemIdentity, verifyVideoTarget } from "../src/core/pddSendItems.js";

// 全部为虚构编号与名称，结构依据诊断记录的字段形态。

const videoReq = { file_type_desc: "video", file_name: "", check_status_list: [2], order_by: "x", page: 1, page_size: 20 };
const video = (id: number, extra: Record<string, unknown> = {}) => ({ id, url_id: id + 1000, mall_id: 1, name: `虚构视频${id}`, extension: "mp4", url: "https://example.invalid/v.mp4", file_type: "video", is_deleted: 0, check_status: 2, extra_info: { duration: 12.4 }, ...extra });
const videoRes = (list: unknown[]) => ({ success: true, result: { total: list.length, file_with_check_dtolist: list } });

const instructRes = (version = 3) => ({
  success: true,
  result: { templateVO: { templateId: 77, templateName: "虚构说明书", version, newPics: [] }, goodsVO: { goodsId: 501, goodsName: "虚构商品" }, instructStatus: 1 },
});
const thumb = (id: number) => `https://img.example.invalid/g${id}.jpg`;
const recommendRes = () => ({
  success: true,
  result: {
    todayBrowseGoods: [{ goodsId: 601, goodsName: "虚构商品六〇一", thumbUrl: thumb(601) }],
    onSaleGoods: [
      { goodsId: 601, goodsName: "虚构商品六〇一", thumbUrl: thumb(601) },
      { goodsId: 602, goodsName: "虚构商品六〇二", thumbUrl: thumb(602) },
      { goodsId: 501, goodsName: "虚构商品", thumbUrl: thumb(501) },
    ],
    returnDiscount: [],
  },
});
const ordersRes = (uid: string) => ({ success: true, result: { orders: [{ uid: Number(uid), orderSn: "sn-1", orderGoodsList: [{ goodsId: 501, goodsName: "虚构商品" }] }] } });

describe("附加发送候选解析", () => {
  test("视频库：只收审核通过、未删除的视频；不带网址", () => {
    const list = parseVideoLibrary(videoReq, videoRes([video(1), video(2, { check_status: 1 }), video(3, { is_deleted: 1 }), video(4, { file_type: "image" })]), 100)!;
    assert.deepEqual(list, [{ type: "video", key: "video:1", name: "虚构视频1", duration: 12, observed_at: 100 }]);
    assert.ok(!JSON.stringify(list).includes("https"));
  });

  test("视频库：搜索或翻页结果不当全集", () => {
    assert.equal(parseVideoLibrary({ ...videoReq, file_name: "x" }, videoRes([video(1)]), 1), null);
    assert.equal(parseVideoLibrary({ ...videoReq, page: 2 }, videoRes([video(1)]), 1), null);
    assert.equal(parseVideoLibrary({ ...videoReq, file_type_desc: "image" }, videoRes([video(1)]), 1), null);
  });

  test("说明书：key 含商品、模板与版本；商品不符或状态异常不作候选", () => {
    assert.equal(parseGoodsInstruct({ goodsId: 501 }, instructRes(), 5)?.option?.key, "instruction:501:77:3");
    assert.equal(parseGoodsInstruct({ goodsId: 502 }, instructRes(), 5)?.option, null);
    const bad = instructRes();
    bad.result.instructStatus = 0;
    assert.equal(parseGoodsInstruct({ goodsId: 501 }, bad, 5)?.option, null);
  });

  test("聊天记录消息身份与候选身份可比（说明书不比版本）", () => {
    const ins = parseGoodsInstruct({ goodsId: 501 }, instructRes(), 5)!.option!;
    assert.equal(sentItemIdentity({ from: { role: "mall_cs" }, template_name: "mall_after_sales_service_product_manual_card", type: 64, info: { data: { goods_info: { goods_id: 501 }, book_info: { book_id: 77 } } } })?.identity, optionIdentity(ins));
    assert.equal(sentItemIdentity({ from: { role: "mall_cs" }, template_name: "library_video", type: 14, info: { file_id: "1", url_id: "1001" } })?.identity, "video:1");
    assert.equal(sentItemIdentity({ from: { role: "mall_cs" }, template_name: "goods_info_card", type: 0, info: { goodsID: 501 } })?.identity, "goods:501");
    assert.equal(sentItemIdentity({ from: { role: "user" }, template_name: "goods_info_card", type: 0, info: { goodsID: 501 } }), null);
  });
});

describe("附加发送候选归集", () => {
  function book() {
    const seen: { buyer: string; options: PlatformSendOption[] }[] = [];
    return { b: new PddSendOptionBook((buyer, options) => seen.push({ buyer, options })), seen };
  }

  test("商品卡片只来自该买家“商品推荐”页签列出的商品，订单商品排前、去重", () => {
    const { b } = book();
    b.response("/latitude/order/userAllOrder", { uid: "9001" }, ordersRes("9001"), 10);
    assert.ok(!b.options("9001").some((o) => o.type === "goods_card"));
    b.response("/latitude/goods/recommendGoods", { uid: "9001", pageNum: 1, pageSize: 20 }, recommendRes(), 11);
    assert.deepEqual(b.options("9001").filter((o) => o.type === "goods_card").map((o) => o.key), ["goods:501", "goods:601", "goods:602"]);
    assert.ok(!b.options("9002").some((o) => o.type === "goods_card"));
  });

  test("说明书只给订单里有该商品的买家；视频对出现过的买家都可用", () => {
    const { b, seen } = book();
    b.response("/latitude/order/userAllOrder", { uid: "9001" }, ordersRes("9001"), 10);
    b.touch("9002");
    b.response("/tornado/instruct/getGoodsInstruct", { goodsId: 501 }, instructRes(), 11);
    b.response("/latitude/user/file/list", videoReq, videoRes([video(1)]), 12);
    const types = (buyer: string) => b.options(buyer).map((o) => o.type).sort();
    assert.deepEqual(types("9001"), ["instruction", "video"]);
    assert.deepEqual(types("9002"), ["video"]);
    assert.ok(seen.length >= 3);
  });

  test("内容不变时重新加载沿用首次时间（不使上下文版本递增）；版本变化则更新", () => {
    const { b } = book();
    b.response("/latitude/order/userAllOrder", { uid: "9001" }, ordersRes("9001"), 10);
    b.response("/tornado/instruct/getGoodsInstruct", { goodsId: 501 }, instructRes(3), 11);
    b.response("/latitude/user/file/list", videoReq, videoRes([video(1)]), 12);
    const first = JSON.stringify(b.options("9001"));
    b.response("/tornado/instruct/getGoodsInstruct", { goodsId: 501 }, instructRes(3), 50);
    b.response("/latitude/user/file/list", videoReq, videoRes([video(1)]), 60);
    assert.equal(JSON.stringify(b.options("9001")), first);
    b.response("/tornado/instruct/getGoodsInstruct", { goodsId: 501 }, instructRes(4), 70);
    const ins = b.options("9001").find((o) => o.type === "instruction")!;
    assert.equal(ins.key, "instruction:501:77:4");
    assert.equal(ins.observed_at, 70);
  });

  test("会话重置后清空候选", () => {
    const { b } = book();
    b.response("/latitude/user/file/list", videoReq, videoRes([video(1)]), 12);
    b.touch("9002");
    b.reset();
    assert.deepEqual(b.options("9002"), []);
  });
});

describe("附加发送回执判断", () => {
  const option: PlatformSendOption = { type: "video", key: "video:1", name: "虚构视频1", observed_at: 1 };
  const vmsg = (msg_id: string, file_id: string, buyer = "9001", role = "mall_cs") => ({ msg_id, buyer, raw: { from: { role }, to: { role: "user", uid: buyer }, template_name: "library_video", type: 14, info: { file_id } } });
  const base = new Set(["old-1"]);

  test("接口成功 + 恰好一条新增且对象一致 → confirmed", () => {
    assert.deepEqual(judgeItemReceipt({ apiOk: true, option, buyer: "9001", baseline: base, seen: [vmsg("old-1", "1"), vmsg("n-1", "1")] }), { status: "confirmed", platform_message_id: "n-1" });
  });

  test("接口失败 → unknown；接口未返回或尚无新增 → 继续等待", () => {
    assert.equal(judgeItemReceipt({ apiOk: false, option, buyer: "9001", baseline: base, seen: [] })?.status, "unknown");
    assert.equal(judgeItemReceipt({ apiOk: null, option, buyer: "9001", baseline: base, seen: [vmsg("n-1", "1")] }), null);
    assert.equal(judgeItemReceipt({ apiOk: true, option, buyer: "9001", baseline: base, seen: [vmsg("old-1", "1")] }), null);
  });

  test("同类新增两条、对象不一致 → unknown；买家消息与其他买家的不计入", () => {
    assert.deepEqual(judgeItemReceipt({ apiOk: true, option, buyer: "9001", baseline: base, seen: [vmsg("n-1", "1"), vmsg("n-2", "2")] }), { status: "unknown", reason: "receipt_ambiguous" });
    assert.deepEqual(judgeItemReceipt({ apiOk: true, option, buyer: "9001", baseline: base, seen: [vmsg("n-1", "2")] }), { status: "unknown", reason: "receipt_object_mismatch" });
    assert.deepEqual(judgeItemReceipt({ apiOk: true, option, buyer: "9001", baseline: base, seen: [vmsg("n-0", "1", "9002"), vmsg("n-9", "1", "9001", "user"), vmsg("n-1", "1")] }), { status: "confirmed", platform_message_id: "n-1" });
  });

  test("同步消息解析只取编号与所属买家", () => {
    const res = { success: true, result: { sync_data: [{ data: [{ message: { msg_id: "77", from: { role: "mall_cs" }, to: { role: "user", uid: "9001" }, type: 14 } }] }] } };
    assert.deepEqual(parseSyncMessages(res).map((m) => [m.msg_id, m.buyer]), [["77", "9001"]]);
  });
});

describe("视频发送前的文件身份核对", () => {
  const LIST_REQ = { file_type_desc: "video", file_name: "", check_status_list: [2], page: 1, page_size: 20 };
  const file = (id: number, name: string) => ({ id, url_id: `u${id}`, name, extension: "mp4", url: `https://video.example.invalid/${id}.mp4`, file_type: "video", is_deleted: 0, check_status: 2, extra_info: { duration: 10, video_cover_url: `https://img.example.invalid/c${id}.jpg` } });
  const rowsOf = (...files: ReturnType<typeof file>[]) => parseVideoRows(LIST_REQ, { success: true, result: { file_with_check_dtolist: files } });
  const optA: PlatformSendOption = { type: "video", key: "video:1", name: "安装视频", observed_at: 1 };

  test("候选文件已不在列表，剩下名称包含它的另一文件：不点击", () => {
    const rows = rowsOf(file(2, "安装视频（新版）"));
    assert.equal(planVideoClick(rows, optA), "pdd_video_file_missing");
  });

  test("同名不同文件：按文件编号定位到对应行，且只放行该文件的请求", () => {
    const rows = rowsOf(file(2, "安装视频"), file(1, "安装视频"));
    const plan = planVideoClick(rows, optA);
    assert.deepEqual(plan, { index: 1, url: "https://video.example.invalid/1.mp4", cover: "https://img.example.invalid/c1.jpg" });
    const watch = { buyer: "9001", url: (plan as { url: string }).url, clicked: true, requests: 0 };
    assert.equal(libraryRequestAllowed(watch, { uid: "9001", url: "https://video.example.invalid/2.mp4" }), false);
    assert.equal(libraryRequestAllowed(watch, { uid: "9001", url: "https://video.example.invalid/1.mp4" }), true);
  });

  const url = (id: number) => `https://video.example.invalid/${id}.mp4`;
  const noSrc = (n: number) => Array.from({ length: n }, () => [] as string[]);

  test("页面行与列表不逐行对应（定位后文件被替换或顺序变化）：不点击", () => {
    const rows = rowsOf(file(2, "说明视频"), file(1, "安装视频"))!;
    assert.deepEqual(verifyVideoTarget(rows, 1, { texts: ["说明视频 00:10 发送", "安装视频 00:10 发送"], srcs: [[url(2)], [url(1)]] }), { basis: "url" });
    assert.equal(verifyVideoTarget(rows, 1, { texts: ["安装视频 00:10 发送", "说明视频 00:10 发送"], srcs: [[url(1)], [url(2)]] }), "pdd_video_rows_mismatch");
    assert.equal(verifyVideoTarget(rows, 1, { texts: ["说明视频 00:10 发送"], srcs: [[url(2)]] }), "pdd_video_rows_mismatch");
  });

  test("同名两行交换且无新列表：仅以行内地址认定", () => {
    const rows = rowsOf(file(1, "安装视频"), file(2, "安装视频"))!;
    const plan = planVideoClick(rows, optA) as { index: number; url: string };
    assert.equal(plan.index, 0);
    const texts = ["安装视频 00:10 发送", "安装视频 00:10 发送"];
    assert.equal(verifyVideoTarget(rows, plan.index, { texts, srcs: noSrc(2) }), "pdd_video_row_identity_missing");
    assert.equal(verifyVideoTarget(rows, plan.index, { texts, srcs: [[url(2)], [url(1)]] }), "pdd_video_row_identity_mismatch");
    assert.deepEqual(verifyVideoTarget(rows, plan.index, { texts, srcs: [[url(1)], [url(2)]] }), { basis: "url" });
  });

  test("名称唯一但行内地址不同或缺少身份：不点击", () => {
    const rows = rowsOf(file(1, "安装视频"), file(3, "清洁说明"))!;
    const texts = ["安装视频 发送", "清洁说明 发送"];
    assert.equal(verifyVideoTarget(rows, 0, { texts, srcs: [[url(2)], []] }), "pdd_video_row_identity_missing");
    assert.equal(verifyVideoTarget(rows, 0, { texts, srcs: noSrc(2) }), "pdd_video_row_identity_missing");
    assert.equal(verifyVideoTarget(rows, 0, { texts, srcs: [["https://img.example.invalid/cover1.jpg"], []] }), "pdd_video_row_identity_missing");
  });

  test("页面行只有封面：封面在列表中独有且只在本行时认定；封面重复或在别的行时不点击", () => {
    const cover = (id: number) => `https://img.example.invalid/c${id}.jpg`;
    const rows = rowsOf(file(1, "安装视频"), file(3, "清洁说明"))!;
    const texts = ["安装视频 发送", "清洁说明 发送"];
    assert.deepEqual(verifyVideoTarget(rows, 0, { texts, srcs: [[cover(1)], [cover(3)]] }), { basis: "cover" });
    assert.equal(verifyVideoTarget(rows, 0, { texts, srcs: [[cover(3)], [cover(1)]] }), "pdd_video_row_identity_mismatch");
    const shared = rows.map((r) => ({ ...r, cover: cover(9) }));
    assert.equal(verifyVideoTarget(shared, 0, { texts, srcs: [[cover(9)], [cover(9)]] }), "pdd_video_row_identity_missing");
    const same = rowsOf(file(1, "安装视频"), file(2, "安装视频"))!;
    assert.equal(verifyVideoTarget(same, 0, { texts: ["安装视频 发送", "安装视频 发送"], srcs: [[cover(2)], [cover(1)]] }), "pdd_video_row_identity_mismatch");
  });

  test("请求买家相同但文件不同、未点击、或第二条请求：拦截", () => {
    const watch = { buyer: "9001", url: "https://video.example.invalid/1.mp4", clicked: true, requests: 0 };
    assert.equal(libraryRequestAllowed(watch, { uid: "9001", url: "https://video.example.invalid/9.mp4" }), false);
    assert.equal(libraryRequestAllowed(watch, { uid: "9002", url: watch.url }), false);
    assert.equal(libraryRequestAllowed({ ...watch, clicked: false }, { uid: "9001", url: watch.url }), false);
    assert.equal(libraryRequestAllowed({ ...watch, requests: 1 }, { uid: "9001", url: watch.url }), false);
    assert.equal(libraryRequestAllowed({ ...watch, url: null }, { uid: "9001", url: null }), false);
  });

  test("正确文件：定位、放行、回执确认", () => {
    const rows = rowsOf(file(1, "安装视频"));
    const plan = planVideoClick(rows, optA) as { index: number; url: string };
    assert.equal(plan.index, 0);
    assert.equal(libraryRequestAllowed({ buyer: "9001", url: plan.url, clicked: true, requests: 0 }, { uid: "9001", url: plan.url }), true);
    const seen = [{ msg_id: "n-1", buyer: "9001", raw: { from: { role: "mall_cs" }, to: { role: "user", uid: "9001" }, template_name: "library_video", type: 14, info: { file_id: "1" } } }];
    assert.deepEqual(judgeItemReceipt({ apiOk: true, option: optA, buyer: "9001", baseline: new Set(), seen }), { status: "confirmed", platform_message_id: "n-1" });
  });

  test("候选名称已变、列表未读到：不点击", () => {
    assert.equal(planVideoClick(rowsOf(file(1, "安装视频v2")), optA), "pdd_video_option_changed");
    assert.equal(planVideoClick(null, optA), "pdd_video_library_not_loaded");
  });
});

test("视频发送接口成功判定：实测成功码 1000000；失败或其他错误码不算成功", () => {
  assert.equal(libraryResponseOk({ success: true, error_code: 1000000 }), true);
  assert.equal(libraryResponseOk({ success: true }), true);
  assert.equal(libraryResponseOk({ success: false, error_code: 1000000 }), false);
  assert.equal(libraryResponseOk({ success: true, error_code: 54001 }), false);
  assert.equal(libraryResponseOk(null), false);
});

describe("商品卡片：页面行身份与请求核对", () => {
  const rows = parseRecommendGoods({ uid: "9001", pageNum: 1 }, recommendRes())!.rows;
  const option = (goods: number): PlatformSendOption => ({ type: "goods_card", key: `goods:${goods}`, goods_title: "x", observed_at: 1 });

  test("解析推荐列表：带买家；非第一页或失败不收", () => {
    assert.equal(parseRecommendGoods({ uid: "9001", pageNum: 1 }, recommendRes())!.buyer, "9001");
    assert.equal(rows.length, 4);
    assert.equal(parseRecommendGoods({ uid: "9001", pageNum: 2 }, recommendRes()), null);
    assert.equal(parseRecommendGoods({ uid: "9001", pageNum: 1 }, { success: false }), null);
    assert.equal(parseRecommendGoods({ pageNum: 1 }, recommendRes()), null);
  });

  test("计划：按商品编号取缩略图；不在列表、缩略图缺失或被他商品共用则不发", () => {
    assert.deepEqual(planGoodsClick(rows, option(602)), { goods_id: "602", thumb: thumb(602) });
    assert.equal(planGoodsClick(rows, option(999)), "pdd_goods_not_in_list");
    assert.equal(planGoodsClick(null, option(602)), "pdd_goods_list_not_loaded");
    const shared = rows.map((r) => (r.goods_id === "601" ? { ...r, thumb: thumb(602) } : r));
    assert.equal(planGoodsClick(shared, option(602)), "pdd_goods_thumb_not_unique");
    assert.equal(planGoodsClick(rows.map((r) => ({ ...r, thumb: null })), option(602)), "pdd_goods_thumb_missing");
  });

  test("核对：选含本商品缩略图、不含他商品缩略图且带按钮的行；行数不符或找不到则不发", () => {
    const srcs = [[thumb(601)], [thumb(601)], [thumb(602)], [thumb(501)]];
    const btn = [true, true, true, true];
    assert.equal(verifyGoodsTarget(rows, "602", { srcs, hasBtn: btn }), 2);
    assert.equal(verifyGoodsTarget(rows, "602", { srcs: srcs.slice(1), hasBtn: btn.slice(1) }), "pdd_goods_rows_mismatch");
    assert.equal(verifyGoodsTarget(rows, "602", { srcs: [[thumb(601)], [thumb(601)], [thumb(602), thumb(501)], [thumb(501)]], hasBtn: btn }), "pdd_goods_row_identity_missing");
    assert.equal(verifyGoodsTarget(rows, "602", { srcs, hasBtn: [true, true, false, true] }), "pdd_goods_row_identity_missing");
  });

  test("请求：仅点击后第一条、买家与商品编号一致时放行", () => {
    const w = { buyer: "9001", goodsId: "602", clicked: true, requests: 0 };
    assert.equal(goodsRequestAllowed(w, { uid: "9001", goods_id: 602, biz_type: 1 }), true);
    assert.equal(goodsRequestAllowed(w, { uid: "9001", goods_id: 601 }), false);
    assert.equal(goodsRequestAllowed(w, { uid: "9002", goods_id: 602 }), false);
    assert.equal(goodsRequestAllowed({ ...w, clicked: false }, { uid: "9001", goods_id: 602 }), false);
    assert.equal(goodsRequestAllowed({ ...w, requests: 1 }, { uid: "9001", goods_id: 602 }), false);
    assert.equal(goodsRequestAllowed({ ...w, goodsId: null }, { uid: "9001", goods_id: 602 }), false);
  });

  test("响应：success 与 result 都为 true 且无错误码才算成功", () => {
    assert.equal(goodsResponseOk({ success: true, result: true, error_code: 1000000 }), true);
    assert.equal(goodsResponseOk({ success: true, result: true }), true);
    assert.equal(goodsResponseOk({ success: true, result: false }), false);
    assert.equal(goodsResponseOk({ success: true, result: true, error_code: 54001 }), false);
    assert.equal(goodsResponseOk(null), false);
  });
});

describe("说明书：对话框身份与请求核对", () => {
  const option = parseGoodsInstruct({ goodsId: 501 }, instructRes(3), 5)!.option!;

  test("对话框所加载的说明书须商品、模板、版本都与候选一致", () => {
    assert.equal(instructMatches(option, { goodsId: 501 }, instructRes(3)), true);
    assert.equal(instructMatches(option, { goodsId: 501 }, instructRes(4)), false);
    assert.equal(instructMatches(option, { goodsId: 502 }, instructRes(3)), false);
    assert.equal(instructMatches(option, { goodsId: 501 }, { success: false }), false);
  });

  test("候选 key → 发送请求应带的商品编号与 bookId", () => {
    assert.deepEqual(instructTarget(option), { goodsId: "501", bookId: "77" });
    assert.equal(instructTarget({ type: "video", key: "video:1", name: "x", observed_at: 1 }), null);
  });

  test("请求：仅点击后第一条、买家、商品编号、bookId 都一致时放行", () => {
    const w = { buyer: "9001", goodsId: "501", bookId: "77", clicked: true, requests: 0 };
    const body = { uid: "9001", goodsId: 501, bookId: 77, goodsName: "虚构商品", thumbUrl: "https://example.invalid/t.jpg" };
    assert.equal(instructRequestAllowed(w, body), true);
    assert.equal(instructRequestAllowed(w, { ...body, bookId: 78 }), false);
    assert.equal(instructRequestAllowed(w, { ...body, goodsId: 502 }), false);
    assert.equal(instructRequestAllowed(w, { ...body, uid: "9002" }), false);
    assert.equal(instructRequestAllowed({ ...w, clicked: false }, body), false);
    assert.equal(instructRequestAllowed({ ...w, requests: 1 }, body), false);
  });

  test("响应：success 为 true 且无错误码（result 为 null）", () => {
    assert.equal(instructResponseOk({ success: true, result: null }), true);
    assert.equal(instructResponseOk({ success: true, result: null, error_code: 1000000 }), true);
    assert.equal(instructResponseOk({ success: false, error_code: 54001 }), false);
    assert.equal(instructResponseOk(null), false);
  });

  test("待加载说明书：订单商品未读到或已过期", () => {
    const b = new PddSendOptionBook(() => undefined);
    b.response("/latitude/order/userAllOrder", { uid: "9001" }, ordersRes("9001"), 10);
    assert.deepEqual(b.instructStale("9001", 100, 600), ["501"]);
    b.response("/tornado/instruct/getGoodsInstruct", { goodsId: 501 }, instructRes(), 100);
    assert.deepEqual(b.instructStale("9001", 200, 600), []);
    assert.deepEqual(b.instructStale("9001", 701, 600), ["501"]);
    assert.deepEqual(b.instructStale("9002", 200, 600), []);
  });
});
