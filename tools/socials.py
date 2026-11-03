#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOML_PATH = ROOT / "socials.toml"
HTML_PATH = ROOT / "public" / "index.html"

ANCHOR = re.compile(r'<a\b[^>]*\bclass="soc"[^>]*>')
BRAND = re.compile(r'\bdata-brand="([^"]+)"')
HREF = re.compile(r'\bhref="[^"]*"')


def load_links() -> dict[str, str]:
    with TOML_PATH.open("rb") as fh:
        data = tomllib.load(fh)
    links = {k: v for k, v in data.items() if isinstance(v, str)}
    if not links:
        sys.exit(f"{TOML_PATH.name}: no string keys found")
    return links


def rewrite(html: str, links: dict[str, str]) -> tuple[str, list[str]]:
    seen: set[str] = set()
    changed: list[str] = []

    def sub(match: re.Match[str]) -> str:
        tag = match.group(0)
        brand_match = BRAND.search(tag)
        if not brand_match:
            return tag
        brand = brand_match.group(1)
        if brand not in links:
            sys.exit(f"{TOML_PATH.name}: no entry for data-brand=\"{brand}\"")
        seen.add(brand)
        href = f'href="{links[brand]}"'
        if HREF.search(tag).group(0) != href:
            changed.append(brand)
        return HREF.sub(href, tag, count=1)

    out = ANCHOR.sub(sub, html)
    extras = set(links) - seen
    if extras:
        sys.exit(f"{TOML_PATH.name}: entries with no matching anchor: {', '.join(sorted(extras))}")
    return out, changed


def main() -> None:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="write changes into public/index.html")
    mode.add_argument("--check", action="store_true", help="exit 1 if out of sync")
    args = ap.parse_args()

    links = load_links()
    current = HTML_PATH.read_text()
    updated, changed = rewrite(current, links)

    if args.check:
        if changed:
            sys.exit("drift: public/index.html is out of sync for " + ", ".join(changed))
        print("links OK")
        return

    if not changed:
        print("links already in sync")
        return

    tmp = HTML_PATH.with_name(HTML_PATH.name + ".tmp")
    tmp.write_text(updated)
    os.replace(tmp, HTML_PATH)
    print(f"updated {HTML_PATH.relative_to(ROOT)} ({', '.join(changed)})")


if __name__ == "__main__":
    main()
