#!/usr/bin/env python3
"""
Scanner that writes straight into Supabase instead of a local file.
This is the one GitHub Actions runs on a schedule, so the board keeps
collecting fresh material without anybody being at a laptop.

Same sources as scan.py. Duplicates are ignored by the unique index on
(title, source), so running it repeatedly is safe.
"""
import os, re, json, time, sys, urllib.request
from datetime import datetime
from html import unescape

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://kayxejofqyxoqlberrgw.supabase.co")
SUPABASE_KEY = os.environ.get(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtheXhlam9mcXl4b3FsYmVycmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzMDg0NDQsImV4cCI6MjEwMTg4NDQ0NH0.LFTOsUpdi7Bu9kibW1qYWYcRSLGnF-mWtDlNMYiJe2E",
)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"}

RSS = {
    "film":   ["https://www.theguardian.com/film/rss",
               "https://variety.com/v/film/feed/",
               "https://www.indiewire.com/feed/",
               "https://deadline.com/feed/"],
    "music":  ["https://www.theguardian.com/music/rss",
               "https://pitchfork.com/feed/feed-news/rss",
               "https://www.nme.com/feed",
               "https://www.stereogum.com/feed/",
               "https://consequence.net/feed/",
               "https://www.billboard.com/feed/",
               "https://www.rollingstone.com/music/music-news/feed/"],
    "tv":     ["https://www.theguardian.com/tv-and-radio/rss"],
    "news":   ["https://feeds.bbci.co.uk/news/world/rss.xml",
               "https://www.theguardian.com/world/rss",
               "https://www.nu.nl/rss/Algemeen"],
    "tech":   ["https://www.theverge.com/rss/index.xml"],
    "art":    ["https://www.theguardian.com/artanddesign/rss",
               "https://www.dazeddigital.com/rss",
               "https://www.highsnobiety.com/feed/",
               "https://hypebeast.com/feed"],
    "youth":  ["https://www.theguardian.com/lifeandstyle/rss",
               "https://knowyourmeme.com/newsfeed.rss"],
    "social": ["https://trends.google.com/trending/rss?geo=NL",
               "https://trends.google.com/trending/rss?geo=US"],
}

SUBS = {
    "social": ["quityourbullshit", "iamverysmart", "OutOfTheLoop"],
    "youth":  ["GenZ", "memes"],
    "film":   ["movies"],
    "music":  ["Music"],
    "tech":   ["technology"],
    "icons":  ["todayilearned"],
}


def get(url, timeout=25):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers=UA), timeout=timeout
    ).read().decode("utf-8", "ignore")


def count_triggers():
    h = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
         "Prefer": "count=exact", "Range": "0-0"}
    r = urllib.request.urlopen(
        urllib.request.Request(SUPABASE_URL + "/rest/v1/triggers?select=id", headers=h),
        timeout=30)
    return int(r.headers.get("Content-Range", "0-0/0").split("/")[-1])


def push(rows):
    """Insert, ignoring anything already there. Returns (accepted, failed)."""
    if not rows:
        return 0, 0
    h = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
         "Content-Type": "application/json",
         "Prefer": "resolution=ignore-duplicates,return=minimal"}
    ok = failed = 0
    for i in range(0, len(rows), 40):          # smaller chunks, large ones were failing
        chunk = rows[i:i + 40]
        # on_conflict names the constraint to ignore against, without it
        # postgrest only checks the primary key and the unique index still throws
        req = urllib.request.Request(SUPABASE_URL + "/rest/v1/triggers?on_conflict=title,source",
                                     data=json.dumps(chunk).encode(),
                                     headers=h, method="POST")
        try:
            urllib.request.urlopen(req, timeout=60)
            ok += len(chunk)
        except Exception as e:
            failed += len(chunk)
            detail = ""
            try:
                detail = e.read().decode()[:160]
            except Exception:
                pass
            print(f"  chunk failed: {e} {detail}", file=sys.stderr)
    return ok, failed


def clean(title):
    return unescape(re.sub(r"<[^>]+>", "", title)).strip()


def collect():
    found = []

    def add(title, url, source, category):
        t = clean(title)
        if len(t) >= 12:
            found.append({"title": t[:300], "url": url[:500],
                          "source": source, "category": category})

    # feeds
    for category, feeds in RSS.items():
        for feed in feeds:
            try:
                xml = get(feed)
            except Exception as e:
                print(f"  skip {feed.split('/')[2]}: {str(e)[:40]}")
                continue
            host = feed.split("/")[2].replace("www.", "")
            for it in re.findall(r"<(?:item|entry)>(.*?)</(?:item|entry)>", xml, re.S)[:12]:
                t = re.search(r"<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", it, re.S)
                l = re.search(r"<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>", it, re.S) \
                    or re.search(r'<link[^>]*href="([^"]+)"', it)
                if t:
                    add(t.group(1), (l.group(1).strip() if l else ""), host, category)
            print(f"  {host} ({category})")

    # reddit, two per run, rotating so we are not throttled every time
    pairs = [(c, s) for c, subs in SUBS.items() for s in subs]
    start = (datetime.now().hour * 2) % len(pairs)
    for category, sub in [pairs[(start + i) % len(pairs)] for i in range(2)]:
        try:
            xml = get(f"https://www.reddit.com/r/{sub}/hot.rss?limit=15")
            for it in re.findall(r"<entry>(.*?)</entry>", xml, re.S)[:12]:
                t = re.search(r"<title[^>]*>(.*?)</title>", it, re.S)
                l = re.search(r'<link[^>]*href="([^"]+)"', it)
                if t:
                    add(t.group(1), (l.group(1) if l else ""), f"r/{sub}", category)
            print(f"  r/{sub} ({category})")
        except Exception as e:
            print(f"  skip r/{sub}: {str(e)[:40]}")
        time.sleep(4)

    # hacker news
    try:
        ids = json.loads(get("https://hacker-news.firebaseio.com/v0/topstories.json"))[:15]
        for i in ids:
            d = json.loads(get(f"https://hacker-news.firebaseio.com/v0/item/{i}.json"))
            add(d.get("title", ""),
                d.get("url") or f"https://news.ycombinator.com/item?id={i}",
                "hackernews", "tech")
        print("  hackernews (tech)")
    except Exception as e:
        print(f"  skip hackernews: {str(e)[:40]}")

    # wikipedia, on this day
    try:
        d = json.loads(get("https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/"
                           + datetime.now().strftime("%m/%d")))
        for e in d.get("events", [])[:15]:
            pages = e.get("pages", [])
            url = pages[0].get("content_urls", {}).get("desktop", {}).get("page", "") if pages else ""
            add(f"{e.get('year')}: {e.get('text','')}", url, "on this day", "icons")
        print("  wikipedia on this day (icons)")
    except Exception as e:
        print(f"  skip wikipedia: {str(e)[:40]}")

    return found


if __name__ == "__main__":
    print(f"scanning {datetime.now().isoformat(timespec='seconds')}")
    rows = collect()
    # drop duplicates within this run
    seen, unique = set(), []
    for r in rows:
        k = (r["title"], r["source"])
        if k not in seen:
            seen.add(k); unique.append(r)
    before = count_triggers()
    ok, failed = push(unique)
    after = count_triggers()
    print(f"\ncollected {len(unique)} · accepted {ok} · failed {failed}")
    print(f"database went {before} -> {after}  ({after - before} genuinely new)")
    if failed:
        sys.exit(1)          # make a broken run show up red in Actions
