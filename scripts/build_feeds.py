#!/usr/bin/env python3
"""Generate feeds.json from the feed XMLs at the repo root.

Run by .github/workflows/deploy.yml on every push (and runnable locally).
Known feeds keep their established identity via OVERRIDES — their ids anchor
readers' localStorage read/star state, so never change them. New XML files
dropped into the repo root are picked up automatically with derived metadata.
"""
import json
import re
import sys
import zlib
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "feeds.json"

# Crawl-failure stub feed (all items are error placeholders; superseded by
# qwen_blog_en/zh) — excluded per repo owner's decision.
EXCLUDE = {"qwen_blog.xml"}

OVERRIDES = {
    "claude_blog.xml": {
        "id": "claude", "title": "Claude Blog", "lang": "en",
        "color": "#d97757", "home": "https://claude.com/blog",
    },
    "qwen_blog_en.xml": {
        "id": "qwen-en", "title": "Qwen Blog", "lang": "en",
        "color": "#615ced", "home": "https://qwen.ai/research",
    },
    "qwen_blog_zh.xml": {
        "id": "qwen-zh", "title": "Qwen 博客", "lang": "zh",
        "color": "#615ced", "home": "https://qwen.ai/research",
    },
    "bytedance_seed_zh.xml": {
        "id": "seed", "title": "ByteDance Seed", "lang": "zh",
        "color": "#2e6be6", "home": "https://seed.bytedance.com/zh/blog",
        "format": "md",
    },
}
ORDER = list(OVERRIDES)  # sidebar order for known feeds; new ones follow

PALETTE = ["#0a84ff", "#30b04f", "#bf5af2", "#ff9f0a", "#64d2ff", "#ff6482", "#ac8e68"]

CJK = re.compile(r"[　-ヿ㐀-䶿一-鿿豈-﫿]")


def cjk_ratio(text):
    if not text:
        return 0.0
    return len(CJK.findall(text)) / len(text)


def parse_feed(path):
    root = ET.parse(path).getroot()
    channel = root.find("channel")
    if channel is None:
        raise ValueError("no <channel>")
    items = channel.findall("item")
    return {
        "title": (channel.findtext("title") or "").strip(),
        "link": (channel.findtext("link") or "").strip(),
        "item_titles": " ".join((it.findtext("title") or "") for it in items),
        "first_desc": next(
            (d.strip() for it in items if (d := (it.findtext("description") or "").strip())), ""
        ),
        "count": len(items),
    }


def derive(name, channel):
    stem = Path(name).stem
    feed_id = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-") or stem
    entry = {
        "id": feed_id,
        "title": channel["title"] or stem,
        "lang": "zh" if cjk_ratio(channel["item_titles"]) > 0.3 else "en",
        "color": PALETTE[zlib.crc32(feed_id.encode()) % len(PALETTE)],
        "home": channel["link"],
    }
    if not channel["first_desc"].startswith("<"):
        entry["format"] = "md"
    return entry


def main():
    known, extra, skipped = {}, [], []

    for path in sorted(ROOT.glob("*.xml")):
        name = path.name
        if name in EXCLUDE:
            skipped.append((name, "excluded"))
            continue
        try:
            channel = parse_feed(path)
        except (ET.ParseError, ValueError) as err:
            skipped.append((name, f"unparseable: {err}"))
            continue
        if channel["count"] == 0:
            skipped.append((name, "no items"))
            continue
        if "example.com" in channel["link"]:
            skipped.append((name, "placeholder channel link"))
            continue

        entry = derive(name, channel)
        entry.update(OVERRIDES.get(name, {}))
        entry["file"] = name
        if name in OVERRIDES:
            known[name] = entry
        else:
            extra.append(entry)

    feeds = [known[n] for n in ORDER if n in known] + sorted(extra, key=lambda f: f["id"])

    for name, reason in skipped:
        print(f"  skip  {name}: {reason}")
    for feed in feeds:
        print(f"  feed  {feed['file']} -> id={feed['id']} title={feed['title']!r} "
              f"lang={feed['lang']} format={feed.get('format', 'html')}")

    if not feeds:
        print("ERROR: no usable feeds found — refusing to build an empty site", file=sys.stderr)
        sys.exit(1)

    manifest = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "feeds": feeds,
    }
    OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.name} with {len(feeds)} feed(s)")


if __name__ == "__main__":
    main()
