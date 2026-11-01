"""publish_client_release.py 的纯虚构场景测试：用本机假 gh 模拟 GitHub，真实 GitHub 读写为零。仅 Linux / macOS。"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "publish_client_release.py")
SHA = "0123456789abcdef0123456789abcdef01234567"
OTHER = "fedcba9876543210fedcba9876543210fedcba98"
RUN = "42"
ZIP = "Claw-Next-Client-darwin-arm64.zip"
TAG = f"client-{RUN}-{SHA}"

FAKE_GH = r'''#!/usr/bin/env python3
import base64, json, os, sys
path = os.environ["FAKE_GH_STATE"]
st = json.load(open(path))
flags = st.setdefault("flags", {})
def save(): json.dump(st, open(path, "w"))
def out(status, data=None):
    sys.stdout.write(f"HTTP/2.0 {status} X\nContent-Type: application/json\n\n" + ("" if data is None else json.dumps(data)))
    save(); sys.exit(0 if status < 400 else 1)
def rel(rid): return next((r for r in st["releases"] if r["id"] == rid), None)
def by_tag(tag):
    m = [r for r in st["releases"] if r["tag_name"] == tag]
    return m[0] if len(m) == 1 else None
def pub(r): return {k: r[k] for k in ("id", "tag_name", "draft", "prerelease")}
a = sys.argv[1:]
if a[0] == "api":
    method, p = a[a.index("-X") + 1], a[a.index("-X") + 2]
    body = json.loads(sys.stdin.read()) if "--input" in a else None
    p, _, q = p.partition("?")
    parts = p.split("/")
    if p.startswith("repos/o/r/git/ref/tags/"):
        if flags.get("ref_error"): out(500, {"message": "boom"})
        ref = st["refs"].get(parts[-1])
        out(200, {"object": ref}) if ref else out(404, {"message": "Not Found"})
    if p.startswith("repos/o/r/git/tags/"):
        t = st["tags"].get(parts[-1])
        out(200, {"object": t}) if t else out(404, {})
    if p == "repos/o/r/releases" and method == "GET":
        if flags.get("list_error"): out(502, {})
        page = int(dict(x.split("=") for x in q.split("&")).get("page", "1"))
        out(200, [pub(r) for r in st["releases"]] if page == 1 else [])
    if p == "repos/o/r/releases" and method == "POST":
        r = {"id": st["next_id"], "tag_name": body["tag_name"], "target": body["target_commitish"], "draft": body["draft"], "prerelease": body["prerelease"], "assets": []}
        st["next_id"] += 1; st["releases"].append(r)
        if flags.get("create_lost"): save(); sys.exit(1)
        if flags.get("create_rejected_after_concurrent_draft"):
            st["releases"].remove(r)
            st["releases"].append({"id": 91, "tag_name": body["tag_name"], "target": body["target_commitish"], "draft": True, "prerelease": True, "assets": []})
            out(422, {"message": "already_exists"})
        out(201, pub(r))
    if len(parts) >= 5 and parts[3] == "releases":
        r = rel(int(parts[4]))
        if len(parts) == 6 and parts[5] == "assets":
            out(200, [{"name": x["name"], "size": len(base64.b64decode(x["b64"]))} for x in r["assets"]]) if r else out(404, {})
        if method == "GET":
            if flags.get("read_error_after_patch") and st.get("patched"): out(503, {})
            out(200, pub(r)) if r else out(404, {})
        if method == "PATCH":
            st["patched"] = True
            if not flags.get("patch_noop"):
                r["draft"] = body["draft"]; r["prerelease"] = body["prerelease"]
                if not r["draft"] and r["tag_name"] not in st["refs"]:
                    st["refs"][r["tag_name"]] = {"type": "commit", "sha": flags.get("tag_moves_to", r["target"])}
            if flags.get("patch_lost"): save(); sys.exit(1)
            out(200, pub(r))
        if method == "DELETE":
            st["releases"].remove(r); st.setdefault("deleted", []).append(r["id"]); out(204)
    out(404, {"message": "unhandled " + p})
if a[0] == "release" and a[1] == "upload":
    r = by_tag(a[2]); name = os.path.basename(a[3])
    if flags.get("published_elsewhere_then_upload_fails"): r["draft"] = False; save(); sys.exit(1)
    if flags.get("upload_fail_on") == name: save(); sys.exit(1)
    r["assets"].append({"name": name, "b64": base64.b64encode(open(a[3], "rb").read()).decode()})
    if flags.get("hidden_asset") and len(r["assets"]) == 1: r["assets"].append({"name": "extra.bin", "b64": "eA=="})
    save(); sys.exit(0)
if a[0] == "release" and a[1] == "download":
    r = by_tag(a[2]); d = a[a.index("--dir") + 1]; name = a[a.index("--pattern") + 1]
    x = next(x for x in r["assets"] if x["name"] == name)
    data = base64.b64decode(x["b64"])
    if flags.get("corrupt_download"): data += b"!"
    open(os.path.join(d, name), "wb").write(data); save(); sys.exit(0)
sys.exit(2)
'''


def make_zip(path, info=None, extra=None):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("Claw-Next-Client.app/Contents/Resources/build-info.json", json.dumps(info or {"sha": SHA, "run": int(RUN), "platform": "darwin", "arch": "arm64"}))
        z.writestr("__MACOSX/Claw-Next-Client.app/._Info.plist", "x")
        for k, v in (extra or {}).items():
            z.writestr(k, v)


class Harness(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="fake-gh-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.bin = os.path.join(self.dir, "bin")
        os.makedirs(self.bin)
        with open(os.path.join(self.bin, "gh"), "w") as f:
            f.write(FAKE_GH)
        os.chmod(os.path.join(self.bin, "gh"), 0o755)
        self.pkg = os.path.join(self.dir, "pkg")
        os.makedirs(self.pkg)
        self.state_path = os.path.join(self.dir, "state.json")
        self.set_state({})

    def set_state(self, flags, refs=None, tags=None, releases=None):
        with open(self.state_path, "w") as f:
            json.dump({"flags": flags, "refs": refs or {}, "tags": tags or {}, "releases": releases or [], "next_id": 7}, f)

    def state(self):
        with open(self.state_path) as f:
            return json.load(f)

    def run_script(self, mode):
        envv = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"], FAKE_GH_STATE=self.state_path, REPO="o/r", SHA=SHA, RUN=RUN, ZIP=ZIP)
        return subprocess.run([sys.executable, SCRIPT, mode, self.pkg], env=envv, capture_output=True, text=True, timeout=60)

    def ready(self):
        make_zip(os.path.join(self.pkg, ZIP))
        self.assertEqual(self.run_script("verify").returncode, 0)


class VerifyTests(Harness):
    def test_good_package(self):
        self.ready()
        self.assertTrue(os.path.exists(os.path.join(self.pkg, ZIP + ".sha256")))

    def test_bad_packages(self):
        for info, extra in [
            ({"sha": SHA, "run": 41, "platform": "darwin", "arch": "arm64"}, None),
            ({"sha": OTHER, "run": int(RUN), "platform": "darwin", "arch": "arm64"}, None),
            (None, {"evil/x": "1"}),
            (None, {"Claw-Next-Client.app/../x": "1"}),
            (None, {"__MACOSX/other/x": "1"}),
        ]:
            make_zip(os.path.join(self.pkg, ZIP), info, extra)
            self.assertNotEqual(self.run_script("verify").returncode, 0, (info, extra))


class PublishTests(Harness):
    def test_normal_first_publish(self):
        self.ready()
        r = self.run_script("publish")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        st = self.state()
        self.assertEqual([(x["tag_name"], x["draft"], x["prerelease"]) for x in st["releases"]], [(TAG, False, True)])
        self.assertEqual(sorted(a["name"] for a in st["releases"][0]["assets"]), [ZIP, ZIP + ".sha256"])
        self.assertEqual(st["refs"][TAG], {"type": "commit", "sha": SHA})

    def assert_untouched(self, r):
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertEqual(self.state()["releases"], [])

    def test_existing_lightweight_tag_without_release(self):
        self.ready()
        self.set_state({}, refs={TAG: {"type": "commit", "sha": OTHER}})
        self.assert_untouched(self.run_script("publish"))

    def test_existing_annotated_tag(self):
        self.ready()
        self.set_state({}, refs={TAG: {"type": "tag", "sha": "t1"}}, tags={"t1": {"type": "commit", "sha": SHA}})
        self.assert_untouched(self.run_script("publish"))

    def test_tag_query_error_stops(self):
        self.ready()
        self.set_state({"ref_error": True})
        self.assert_untouched(self.run_script("publish"))

    def test_release_list_error_stops(self):
        self.ready()
        self.set_state({"list_error": True})
        self.assert_untouched(self.run_script("publish"))

    def test_existing_draft_is_not_touched(self):
        self.ready()
        mine = {"id": 3, "tag_name": TAG, "target": SHA, "draft": True, "prerelease": True, "assets": []}
        self.set_state({}, releases=[mine])
        r = self.run_script("publish")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.state()["releases"], [mine])

    def test_upload_failure_deletes_own_draft(self):
        self.ready()
        self.set_state({"upload_fail_on": ZIP + ".sha256"})
        r = self.run_script("publish")
        self.assertNotEqual(r.returncode, 0)
        st = self.state()
        self.assertEqual((st["releases"], st.get("deleted")), ([], [7]))
        self.assertNotIn(TAG, st["refs"])

    def test_release_no_longer_draft_is_never_deleted(self):
        # 上传失败时读回发现已不是草稿（例如被他人转为发布）：不删除，只报错。
        self.ready()
        self.set_state({"published_elsewhere_then_upload_fails": True})
        self.assertNotEqual(self.run_script("publish").returncode, 0)
        st = self.state()
        self.assertEqual([x["draft"] for x in st["releases"]], [False])
        self.assertIsNone(st.get("deleted"))

    def test_hidden_extra_asset_rejected(self):
        self.ready()
        self.set_state({"hidden_asset": True})
        r = self.run_script("publish")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.state()["releases"], [])

    def test_corrupt_download_rejected(self):
        self.ready()
        self.set_state({"corrupt_download": True})
        self.assertNotEqual(self.run_script("publish").returncode, 0)
        self.assertEqual(self.state()["releases"], [])

    def test_create_response_lost_is_left_for_manual_check(self):
        # 创建响应丢失：没有本次 id，不认领同名草稿，保留现状、报错。
        self.ready()
        self.set_state({"create_lost": True})
        self.assertNotEqual(self.run_script("publish").returncode, 0)
        st = self.state()
        self.assertEqual([x["draft"] for x in st["releases"]], [True])
        self.assertIsNone(st.get("deleted"))

    def test_concurrent_draft_then_create_rejected_is_not_deleted(self):
        # 预检之后别人建了同名草稿（id 91），本次 POST 被 422 拒绝：别人的草稿不得被删。
        self.ready()
        self.set_state({"create_rejected_after_concurrent_draft": True})
        self.assertNotEqual(self.run_script("publish").returncode, 0)
        st = self.state()
        self.assertEqual([x["id"] for x in st["releases"]], [91])
        self.assertIsNone(st.get("deleted"))

    def test_publish_response_lost_but_applied_is_kept(self):
        self.ready()
        self.set_state({"patch_lost": True})
        r = self.run_script("publish")
        self.assertEqual(r.returncode, 0, r.stdout)
        st = self.state()
        self.assertEqual([(x["draft"], x["prerelease"]) for x in st["releases"]], [(False, True)])
        self.assertIsNone(st.get("deleted"))

    def test_publish_not_applied_deletes_confirmed_draft(self):
        self.ready()
        self.set_state({"patch_noop": True, "patch_lost": True})
        self.assertNotEqual(self.run_script("publish").returncode, 0)
        self.assertEqual(self.state()["releases"], [])

    def test_state_unknown_after_publish_is_left_untouched(self):
        self.ready()
        self.set_state({"read_error_after_patch": True})
        self.assertNotEqual(self.run_script("publish").returncode, 0)
        st = self.state()
        self.assertEqual(len(st["releases"]), 1)
        self.assertIsNone(st.get("deleted"))

    def test_tag_pointing_elsewhere_after_publish_fails_without_delete(self):
        self.ready()
        self.set_state({"tag_moves_to": OTHER})
        self.assertNotEqual(self.run_script("publish").returncode, 0)
        st = self.state()
        self.assertEqual([x["draft"] for x in st["releases"]], [False])
        self.assertIsNone(st.get("deleted"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
