# airss

Self-updating full-text RSS feeds for a few AI blogs, plus a [Reeder](https://reederapp.com/)-style web reader to browse them.

**Read it here → https://wuhx.github.io/airss/**

## Feeds

| Feed | Source | File |
| --- | --- | --- |
| Claude Blog | https://claude.com/blog | [`claude_blog.xml`](claude_blog.xml) |
| Qwen Blog (English) | https://qwen.ai/research | [`qwen_blog_en.xml`](qwen_blog_en.xml) |
| Qwen 博客 (中文) | https://qwen.ai/research | [`qwen_blog_zh.xml`](qwen_blog_zh.xml) |
| ByteDance Seed (中文) | https://seed.bytedance.com/zh/blog | [`bytedance_seed_zh.xml`](bytedance_seed_zh.xml) |

The XML files at the repo root are full-text RSS 2.0 feeds, refreshed by an external crawler that pushes to `main`.

## Reader

The site is a static, dependency-free web app ([`index.html`](index.html) + [`assets/`](assets/)) served by GitHub Pages straight from this branch — every feed update automatically republishes it. It fetches the XML files from the same origin, sanitizes the article HTML, and renders a three-pane, keyboard-friendly reader (<kbd>j</kbd>/<kbd>k</kbd> to navigate, <kbd>o</kbd> to open the original, <kbd>s</kbd> to star, <kbd>/</kbd> to search). Read state, starred items, and theme live in `localStorage`.
