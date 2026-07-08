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
| Zhipu AI News (中文) | https://www.zhipuai.cn/zh/news | [`zhipuai_news.xml`](zhipuai_news.xml) |
| MiniMax News | https://www.minimaxi.com/news | [`minimax_news.xml`](minimax_news.xml) |
| MiniMax Blog | https://www.minimaxi.com/blog | [`minimax_blog.xml`](minimax_blog.xml) |
| Kling Blog | https://kling.ai/blog | [`kling_blog.xml`](kling_blog.xml) |
| Mistral News | https://mistral.ai/news/ | [`mistral_news.xml`](mistral_news.xml) |
| OpenAI Blog | https://openai.com/blog/ | [`openai_blog.xml`](openai_blog.xml) |
| DeepMind Blog | https://deepmind.google/blog/ | [`deepmind_blog.xml`](deepmind_blog.xml) |
| NVIDIA News | https://nvidianews.nvidia.com/in-the-news | [`nvidia_news.xml`](nvidia_news.xml) |
| NVIDIA Blog | https://blogs.nvidia.com/ | [`nvidia_blog.xml`](nvidia_blog.xml) |
| Meta AI Blog | https://ai.meta.com/blog/ | [`meta_ai_blog.xml`](meta_ai_blog.xml) |
| Apple Newsroom | https://www.apple.com/newsroom/ | [`apple_newsroom.xml`](apple_newsroom.xml) |
| Apple ML Highlights | https://machinelearning.apple.com/highlights | [`apple_ml_highlights.xml`](apple_ml_highlights.xml) |
| Microsoft AI News | https://news.microsoft.com/source/topics/ai/ | [`microsoft_ai_news.xml`](microsoft_ai_news.xml) |

The XML files at the repo root are full-text RSS 2.0 feeds, refreshed by an external crawler that pushes to `main`.

## Reader

The site is a static, dependency-free web app ([`index.html`](index.html) + [`assets/`](assets/)). On every push to `main`, the [Deploy Pages workflow](.github/workflows/deploy.yml) runs [`scripts/build_feeds.py`](scripts/build_feeds.py) to regenerate the `feeds.json` manifest from the XML files and deploys the site to GitHub Pages — so feed updates republish automatically, and **dropping a new feed XML into the repo root adds it to the site** with no code changes (known feeds keep curated titles/colors via the script's `OVERRIDES`).

The app fetches the XML files from the same origin, sanitizes the article HTML, and renders a three-pane, keyboard-friendly reader (<kbd>j</kbd>/<kbd>k</kbd> to navigate, <kbd>o</kbd> to open the original, <kbd>s</kbd> to star, <kbd>/</kbd> to search). Read state, starred items, and theme live in `localStorage`.
