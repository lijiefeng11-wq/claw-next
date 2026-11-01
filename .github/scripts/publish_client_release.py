#!/usr/bin/env python3
"""发布客户端 Mac 预发布版本（#34 第 b 步）。只由 CI 的 publish-client-release job 调用。

用法：publish_client_release.py verify|publish <pkg 目录>
环境：REPO（owner/name）、SHA（40 位完整提交）、RUN（运行序号）、ZIP（zip 文件名）。
只调用 runner 自带的 gh；所有 GitHub 读写都核对 HTTP 状态，状态不明一律停下，不猜测、不盲删：
- 发布前：同名 git tag 必须明确不存在（404），任何同名 release（含草稿）都不存在；查询失败即停止。
- 先建草稿并立即记下 release id，再上传；资产按 API 名单核对恰好两个固定文件，并下载回来逐字节比较。
- 转为预发布后读回核对；随后核对真实 tag 最终指向本次完整 SHA。
- 失败时只删除“读回确认仍是草稿且 id 为本次创建”的 release；已发布或无法确认的一律保留并报错。
"""
import hashlib
import json
import os
import subprocess
import sys
import zipfile

APP = "Claw-Next-Client.app"


class Stop(Exception):
    pass


def env(name):
    value = os.environ.get(name, "")
    if not value:
        raise Stop(f"missing env {name}")
    return value


def api(method, path, body=None):
    """调用 gh api -i，返回 (HTTP 状态或 None, 解析后的 JSON 或 None)。状态为 None 表示结果不明。"""
    args = ["gh", "api", "-i", "-X", method, path]
    if body is not None:
        args += ["--input", "-"]
    try:
        proc = subprocess.run(args, input=json.dumps(body) if body is not None else None, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    out = proc.stdout.replace("\r\n", "\n")
    head, sep, rest = out.partition("\n\n")
    first = head.split("\n", 1)[0].split()
    if not sep or len(first) < 2 or not first[0].startswith("HTTP/") or not first[1].isdigit():
        return None, None
    status = int(first[1])
    try:
        data = json.loads(rest) if rest.strip() else None
    except ValueError:
        data = None
    return status, data


def gh(*args):
    try:
        return subprocess.run(["gh", *args], capture_output=True, text=True, timeout=600).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify(pkg):
    zip_name, sha, run = env("ZIP"), env("SHA"), int(env("RUN"))
    path = os.path.join(pkg, zip_name)
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if not names or len(names) != len(set(names)):
            raise Stop("duplicate or empty zip entries")
        for n in names:
            parts = n.split("/")
            if n.startswith("/") or "\\" in n or ".." in parts:
                raise Stop(f"unsafe entry: {n}")
            # ditto --sequesterRsrc 把扩展属性放在 __MACOSX/ 下（AppleDouble），只允许属于本 .app 的那部分。
            if not (parts[0] == APP or (parts[0] == "__MACOSX" and len(parts) > 1 and parts[1] in (APP, "._" + APP))):
                raise Stop(f"unexpected root: {n}")
        info = json.loads(z.read(f"{APP}/Contents/Resources/build-info.json"))
    want = {"sha": sha, "run": run, "platform": "darwin", "arch": "arm64"}
    if info != want:
        raise Stop(f"build-info mismatch: {info} != {want}")
    with open(path + ".sha256", "w") as f:
        f.write(f"{sha256(path)}  {zip_name}\n")
    print("verified", info)


def releases_with_tag(repo, tag):
    """分页列出全部 release（含草稿），返回同名 tag 的 release 列表；查询不明抛 Stop。"""
    found, page = [], 1
    while True:
        status, data = api("GET", f"repos/{repo}/releases?per_page=100&page={page}")
        if status != 200 or not isinstance(data, list):
            raise Stop(f"cannot list releases (status {status})")
        found += [r for r in data if isinstance(r, dict) and r.get("tag_name") == tag]
        if len(data) < 100:
            return found
        page += 1


def tag_commit(repo, tag):
    """返回 tag 最终指向的提交 SHA；明确不存在返回 None；查询不明抛 Stop。带注释 tag 逐层解引用。"""
    status, data = api("GET", f"repos/{repo}/git/ref/tags/{tag}")
    if status == 404:
        return None
    if status != 200 or not isinstance(data, dict) or not isinstance(data.get("object"), dict):
        raise Stop(f"cannot read tag ref (status {status})")
    obj = data["object"]
    for _ in range(5):
        if obj.get("type") == "commit":
            return obj.get("sha")
        if obj.get("type") != "tag":
            raise Stop(f"tag points to {obj.get('type')}")
        status, data = api("GET", f"repos/{repo}/git/tags/{obj.get('sha')}")
        if status != 200 or not isinstance(data, dict) or not isinstance(data.get("object"), dict):
            raise Stop(f"cannot read annotated tag (status {status})")
        obj = data["object"]
    raise Stop("tag chain too deep")


def read_release(repo, rid):
    status, data = api("GET", f"repos/{repo}/releases/{rid}")
    return data if status == 200 and isinstance(data, dict) and data.get("id") == rid else None


def cleanup(repo, rid, tag):
    """只删除读回确认仍是本次草稿的 release；已发布或无法确认一律保留。"""
    rel = read_release(repo, rid)
    if rel is None:
        print(f"::error::release {rid} state unknown; left untouched")
        return
    if rel.get("draft") is not True or rel.get("tag_name") != tag:
        print(f"::error::release {rid} is not an unfinished draft of {tag}; left untouched")
        return
    status, _ = api("DELETE", f"repos/{repo}/releases/{rid}")
    print(f"deleted unfinished draft {rid} (status {status})" if status == 204 else f"::error::draft {rid} delete status {status}")


def publish(pkg):
    repo, sha, run, zip_name = env("REPO"), env("SHA"), env("RUN"), env("ZIP")
    tag = f"client-{run}-{sha}"
    files = [zip_name, zip_name + ".sha256"]
    # 不覆盖：同名 tag 必须明确不存在，同名 release（含草稿）也不存在。
    if tag_commit(repo, tag) is not None:
        raise Stop(f"tag {tag} already exists")
    if releases_with_tag(repo, tag):
        raise Stop(f"release {tag} already exists")
    body = {
        "tag_name": tag, "target_commitish": sha, "name": f"Claw-Next 客户端（Mac）构建 {run}",
        "body": f"自动发布：main 提交 {sha}，CI 运行序号 {run}。已通过本次运行的全部检查与 Mac 冒烟测试。未签名；首次打开可能需要按 macOS 提示手动允许。",
        "draft": True, "prerelease": True, "make_latest": "false",
    }
    status, data = api("POST", f"repos/{repo}/releases", body)
    rid = data.get("id") if status == 201 and isinstance(data, dict) else None
    if not isinstance(rid, int):
        # 创建结果不明：发布前已确认没有同名 release，只有恰好一个同名草稿才能确定是本次创建的。
        drafts = [r for r in releases_with_tag(repo, tag) if r.get("draft") is True]
        if len(drafts) == 1 and isinstance(drafts[0].get("id"), int):
            cleanup(repo, drafts[0]["id"], tag)
        raise Stop(f"create draft failed (status {status})")
    print(f"draft {rid} created")
    try:
        for name in files:
            if not gh("release", "upload", tag, os.path.join(pkg, name), "--repo", repo):
                raise Stop(f"upload {name} failed")
        status, assets = api("GET", f"repos/{repo}/releases/{rid}/assets?per_page=100")
        if status != 200 or not isinstance(assets, list):
            raise Stop(f"cannot list assets (status {status})")
        listed = sorted((a.get("name"), a.get("size")) for a in assets if isinstance(a, dict))
        want = sorted((n, os.path.getsize(os.path.join(pkg, n))) for n in files)
        if listed != want:
            raise Stop(f"assets mismatch: {listed} != {want}")
        check = os.path.join(pkg, "check")
        os.makedirs(check, exist_ok=True)
        for name in files:
            if not gh("release", "download", tag, "--repo", repo, "--dir", check, "--pattern", name):
                raise Stop(f"download {name} failed")
            if sha256(os.path.join(check, name)) != sha256(os.path.join(pkg, name)):
                raise Stop(f"downloaded {name} differs")
    except Stop:
        cleanup(repo, rid, tag)
        raise
    # 转为预发布；无论响应如何都读回确认，不按响应猜状态。
    api("PATCH", f"repos/{repo}/releases/{rid}", {"draft": False, "prerelease": True, "make_latest": "false"})
    rel = read_release(repo, rid)
    if rel is None:
        raise Stop(f"release {rid} state unknown after publish; left untouched")
    if rel.get("draft") is True:
        cleanup(repo, rid, tag)
        raise Stop("publish did not take effect")
    if rel.get("tag_name") != tag or rel.get("prerelease") is not True:
        raise Stop(f"published release mismatch: tag={rel.get('tag_name')} prerelease={rel.get('prerelease')}")
    # 真实 tag 必须指向本次完整 SHA（已发布的不删，只报错）。
    final = tag_commit(repo, tag)
    if final != sha:
        raise Stop(f"tag {tag} points to {final}, expected {sha}")
    print(f"published {tag} (release {rid})")


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("verify", "publish"):
        print(__doc__)
        return 2
    try:
        (verify if sys.argv[1] == "verify" else publish)(sys.argv[2])
    except Stop as err:
        print(f"::error::{err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
