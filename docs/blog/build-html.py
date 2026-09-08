#!/usr/bin/env python3
"""Render docs/blog/self-evolution-development.en.md to .en.html.

Reuses the stylesheet of the hand-written Chinese page so both look the same, and
reproduces its structure: <header> (h1, .sub, .meta), <figure>/<figcaption> for an image
followed by an italic caption line, and a <footer> for the paragraph after the final rule.

Run: python3 docs/blog/build-html.py
"""
import re
from pathlib import Path

from markdown_it import MarkdownIt

HERE = Path(__file__).resolve().parent
SRC = HERE / "self-evolution-development.en.md"
OUT = HERE / "self-evolution-development.en.html"
STYLE_FROM = HERE / "self-evolution-development.zh-CN.html"


def main() -> None:
    md = MarkdownIt("commonmark").enable("table")
    body = md.render(SRC.read_text(encoding="utf-8"))

    # header: h1 + italic subtitle + meta line
    m = re.match(r"<h1>(.*?)</h1>\n<p><em>(.*?)</em></p>\n<p>(.*?)</p>\n", body, re.S)
    if not m:
        raise SystemExit("unexpected head of document")
    title, sub, meta = m.groups()
    header = (
        "<header>\n"
        f"  <h1>{title}</h1>\n"
        f'  <p class="sub">{sub}</p>\n'
        f'  <p class="meta">{meta}</p>\n'
        "</header>\n"
    )
    body = header + body[m.end():]

    # image paragraph followed by an italic caption paragraph → figure
    body = re.sub(
        r'<p><img src="([^"]+)" alt="([^"]*)" ?/?></p>\n<p><em>(.*?)</em></p>',
        lambda g: (
            "<figure>\n"
            f'  <img src="{g.group(1)}" alt="{g.group(2)}">\n'
            f"  <figcaption>{g.group(3)}</figcaption>\n"
            "</figure>"
        ),
        body,
        flags=re.S,
    )

    # trailing rule + last paragraph → footer
    body = re.sub(r"<hr ?/?>\n<p>(.*?)</p>\n?$", r"<footer>\n  <p>\1</p>\n</footer>\n", body, flags=re.S)

    style = re.search(r"<style>.*?</style>", STYLE_FROM.read_text(encoding="utf-8"), re.S)
    if not style:
        raise SystemExit("stylesheet not found in the zh-CN page")

    html = (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{re.sub('<[^>]+>', '', title)}</title>\n"
        f"{style.group(0)}\n"
        "</head>\n"
        "<body>\n"
        "<article>\n\n"
        f"{body}\n"
        "</article>\n"
        "</body>\n"
        "</html>\n"
    )
    OUT.write_text(html, encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
