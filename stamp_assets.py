#!/usr/bin/env python3
"""Add ?v=<deploy time> to every local script and stylesheet in a page.

Without this the browser serves the previous copy from cache and a deploy looks
like it did nothing. That cost real time on 13 Aug: the file was live on the
server, the page was running the old one, and every diagnosis downstream of
that was chasing a bug that had already been fixed.
"""
import io, re, sys, time

path = sys.argv[1]
stamp = sys.argv[2] if len(sys.argv) > 2 else str(int(time.time()))
html = io.open(path, encoding="utf-8").read()


def bump(m):
    attr, url = m.group(1), m.group(2)
    if url.startswith(("http://", "https://", "//", "data:")):
        return m.group(0)
    return f'{attr}="{url}?v={stamp}"'


html = re.sub(r'\b(src|href)="([^"?]+\.(?:js|css))(?:\?[^"]*)?"', bump, html)
io.open(path, "w", encoding="utf-8").write(html)
print(f"  stamped assets with v={stamp}")
