"""Scrapling only parses fictional HTML received from verify-selectors.mjs; no fetchers."""
import json
import sys
from scrapling import Selector

request = json.loads(sys.stdin.read(1024 * 1024))
document = Selector(content=request["html"], adaptive=False)
counts = {name: len(document.css(css)) for name, css in request["selectors"].items()}
print(json.dumps({"counts": counts, "adaptive": False, "network": False}))
