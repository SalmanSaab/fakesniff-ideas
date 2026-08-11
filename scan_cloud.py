#!/usr/bin/env python3
# Codex — 2026-08-11
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
from urllib.parse import urlparse
from uuid import UUID, uuid4

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
# Codex — V1 passes the powerful Supabase service-role secret under this generic
# name. Keep it server-side in the default-branch-restricted scanner-production
# GitHub Environment. A least-privilege RPC/Edge Function is the preferred
# replacement; Supabase does not automatically issue a scoped PostgREST key.
SUPABASE_KEY = os.environ.get("SUPABASE_SCANNER_KEY", "")
WORKSPACE_ID = os.environ.get("SUPABASE_WORKSPACE_ID", "")
EXTERNAL_RUN_ID = os.environ.get("SCANNER_RUN_ID", "") or f"local-{uuid4()}"
COMMIT_SHA = os.environ.get("SCANNER_COMMIT_SHA", "")[:80]

# Leave enough of the 15-minute Actions limit to record the final run state even
# when upstream sites and the database are slow.
COLLECTION_BUDGET_SECONDS = 420
SOURCE_TIMEOUT_SECONDS = 12
API_TIMEOUT_SECONDS = 20

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


def validate_config():
    """Fail closed: the scheduled scanner has no built-in endpoint or key."""
    missing = [name for name, value in (
        ("SUPABASE_URL", SUPABASE_URL),
        ("SUPABASE_SCANNER_KEY", SUPABASE_KEY),
        ("SUPABASE_WORKSPACE_ID", WORKSPACE_ID),
    ) if not value]
    if missing:
        raise RuntimeError("missing required environment variables: " + ", ".join(missing))

    parsed = urlparse(SUPABASE_URL)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise RuntimeError("SUPABASE_URL must be an HTTPS origin without credentials")
    try:
        UUID(WORKSPACE_ID)
    except ValueError as exc:
        raise RuntimeError("SUPABASE_WORKSPACE_ID must be a UUID") from exc


def api_headers(prefer=None):
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def start_run():
    body = [{
        "workspace_id": WORKSPACE_ID,
        "external_run_id": EXTERNAL_RUN_ID[:200],
        "status": "running",
        "commit_sha": COMMIT_SHA or None,
        "details": {"scanner": "scan_cloud.py"},
    }]
    request = urllib.request.Request(
        SUPABASE_URL + "/rest/v1/scanner_runs",
        data=json.dumps(body).encode(),
        headers=api_headers("return=representation"),
        method="POST",
    )
    response = urllib.request.urlopen(request, timeout=API_TIMEOUT_SECONDS)
    rows = json.loads(response.read().decode())
    if not rows or not rows[0].get("id"):
        raise RuntimeError("scanner run record was not created")
    return rows[0]["id"]


def finish_run(run_id, status, **fields):
    body = {"status": status, "finished_at": datetime.now().astimezone().isoformat()}
    body.update(fields)
    request = urllib.request.Request(
        SUPABASE_URL + f"/rest/v1/scanner_runs?id=eq.{run_id}&workspace_id=eq.{WORKSPACE_ID}",
        data=json.dumps(body).encode(),
        headers=api_headers("return=minimal"),
        method="PATCH",
    )
    urllib.request.urlopen(request, timeout=API_TIMEOUT_SECONDS)


def count_triggers(scanner_run_id=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
         "Prefer": "count=exact", "Range": "0-0"}
    filters = f"workspace_id=eq.{WORKSPACE_ID}&archived_at=is.null"
    if scanner_run_id:
        filters += f"&scanner_run_id=eq.{scanner_run_id}"
    r = urllib.request.urlopen(
        urllib.request.Request(
            SUPABASE_URL
            + f"/rest/v1/triggers?select=id&{filters}",
            headers=h,
        ),
        timeout=API_TIMEOUT_SECONDS)
    return int(r.headers.get("Content-Range", "0-0/0").split("/")[-1])


def push(rows, scanner_run_id):
    """Insert, ignoring anything already there. Returns (accepted, failed)."""
    if not rows:
        return 0, 0
    h = api_headers("resolution=ignore-duplicates,return=minimal")
    ok = failed = 0
    for i in range(0, len(rows), 40):          # smaller chunks, large ones were failing
        chunk = [dict(row, workspace_id=WORKSPACE_ID, scanner_run_id=scanner_run_id)
                 for row in rows[i:i + 40]]
        # on_conflict names the constraint to ignore against, without it
        # postgrest only checks the primary key and the unique index still throws
        req = urllib.request.Request(
                                     SUPABASE_URL + "/rest/v1/triggers?on_conflict=workspace_id,title,source",
                                     data=json.dumps(chunk).encode(),
                                     headers=h, method="POST")
        try:
            urllib.request.urlopen(req, timeout=API_TIMEOUT_SECONDS)
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
    deadline = time.monotonic() + COLLECTION_BUDGET_SECONDS
    stats = {"attempted": 0, "succeeded": 0, "failed": 0,
             "budget_exhausted": False}

    def fetch(url):
        remaining = deadline - time.monotonic()
        if remaining < 1:
            stats["budget_exhausted"] = True
            raise TimeoutError("collection time budget exhausted")
        return get(url, timeout=min(SOURCE_TIMEOUT_SECONDS, remaining))

    def has_budget():
        if time.monotonic() < deadline:
            return True
        stats["budget_exhausted"] = True
        return False

    def add(title, url, source, category):
        t = clean(title)
        if len(t) >= 12:
            found.append({"title": t[:300], "url": url[:500],
                          "source": source, "category": category})

    # feeds
    for category, feeds in RSS.items():
        for feed in feeds:
            if not has_budget():
                break
            stats["attempted"] += 1
            try:
                xml = fetch(feed)
            except Exception as e:
                stats["failed"] += 1
                print(f"  skip {feed.split('/')[2]}: {str(e)[:40]}")
                continue
            stats["succeeded"] += 1
            host = feed.split("/")[2].replace("www.", "")
            for it in re.findall(r"<(?:item|entry)>(.*?)</(?:item|entry)>", xml, re.S)[:12]:
                t = re.search(r"<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", it, re.S)
                l = re.search(r"<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>", it, re.S) \
                    or re.search(r'<link[^>]*href="([^"]+)"', it)
                if t:
                    add(t.group(1), (l.group(1).strip() if l else ""), host, category)
            print(f"  {host} ({category})")
        if not has_budget():
            break

    # reddit, two per run, rotating so we are not throttled every time
    pairs = [(c, s) for c, subs in SUBS.items() for s in subs]
    start = (datetime.now().hour * 2) % len(pairs)
    for category, sub in [pairs[(start + i) % len(pairs)] for i in range(2)]:
        if not has_budget():
            break
        stats["attempted"] += 1
        try:
            xml = fetch(f"https://www.reddit.com/r/{sub}/hot.rss?limit=15")
            for it in re.findall(r"<entry>(.*?)</entry>", xml, re.S)[:12]:
                t = re.search(r"<title[^>]*>(.*?)</title>", it, re.S)
                l = re.search(r'<link[^>]*href="([^"]+)"', it)
                if t:
                    add(t.group(1), (l.group(1) if l else ""), f"r/{sub}", category)
            stats["succeeded"] += 1
            print(f"  r/{sub} ({category})")
        except Exception as e:
            stats["failed"] += 1
            print(f"  skip r/{sub}: {str(e)[:40]}")
        time.sleep(min(4, max(0, deadline - time.monotonic())))

    # hacker news
    if has_budget():
        stats["attempted"] += 1
        try:
            ids = json.loads(fetch(
                "https://hacker-news.firebaseio.com/v0/topstories.json"))[:15]
            loaded = 0
            for i in ids:
                if not has_budget():
                    break
                try:
                    d = json.loads(fetch(
                        f"https://hacker-news.firebaseio.com/v0/item/{i}.json"))
                except Exception as e:
                    print(f"  skip hackernews item {i}: {str(e)[:40]}")
                    continue
                loaded += 1
                add(d.get("title", ""),
                    d.get("url") or f"https://news.ycombinator.com/item?id={i}",
                    "hackernews", "tech")
            if loaded:
                stats["succeeded"] += 1
                print("  hackernews (tech)")
            else:
                stats["failed"] += 1
                print("  skip hackernews: no items loaded")
        except Exception as e:
            stats["failed"] += 1
            print(f"  skip hackernews: {str(e)[:40]}")

    # wikipedia, on this day
    if has_budget():
        stats["attempted"] += 1
        try:
            d = json.loads(fetch(
                "https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/"
                + datetime.now().strftime("%m/%d")))
            for e in d.get("events", [])[:15]:
                pages = e.get("pages", [])
                url = pages[0].get("content_urls", {}).get("desktop", {}).get("page", "") if pages else ""
                add(f"{e.get('year')}: {e.get('text','')}", url, "on this day", "icons")
            stats["succeeded"] += 1
            print("  wikipedia on this day (icons)")
        except Exception as e:
            stats["failed"] += 1
            print(f"  skip wikipedia: {str(e)[:40]}")

    return found, stats


def main():
    try:
        validate_config()
    except RuntimeError as exc:
        print(f"scanner configuration error: {exc}", file=sys.stderr)
        return 2
    print(f"scanning {datetime.now().isoformat(timespec='seconds')}")
    try:
        run_id = start_run()
    except Exception as exc:
        print(f"could not create scanner run: {type(exc).__name__}: {str(exc)[:300]}",
              file=sys.stderr)
        return 1
    before = after = 0

    try:
        before = count_triggers()
        rows, source_stats = collect()
        # Drop duplicates within this run.
        seen, unique = set(), []
        for row in rows:
            key = (row["title"], row["source"])
            if key not in seen:
                seen.add(key)
                unique.append(row)

        accepted, failed = push(unique, run_id)
        after = count_triggers()
        # Codex — rows are attributed by scanner_run_id; a global count delta can
        # include concurrent edits and is not evidence of what this run inserted.
        inserted = count_triggers(run_id)
        all_sources_failed = source_stats["succeeded"] == 0
        degraded = (source_stats["failed"] > 0
                    or source_stats["budget_exhausted"])
        status = "failed" if failed or all_sources_failed else "succeeded"
        error_parts = []
        if failed:
            error_parts.append(f"{failed} rows were in failed request chunks")
        if all_sources_failed:
            error_parts.append("all attempted upstream sources failed")
        finish_run(
            run_id,
            status,
            before_count=before,
            after_count=after,
            collected_count=len(unique),
            submitted_count=len(unique),
            inserted_count=inserted,
            failed_count=failed,
            error_message=("; ".join(error_parts) or None),
            details={"scanner": "scan_cloud.py", "sources": source_stats,
                     "degraded": degraded},
        )
        print(f"\ncollected {len(unique)} · submitted {accepted} · failed {failed}")
        print(f"database went {before} -> {after}  ({inserted} inserted by this run)")
        if degraded:
            print(f"collection degraded: {source_stats}", file=sys.stderr)
        return 1 if status == "failed" else 0
    except Exception as exc:
        safe_message = f"{type(exc).__name__}: {str(exc)[:500]}"
        try:
            finish_run(
                run_id,
                "failed",
                before_count=before,
                after_count=after or None,
                error_message=safe_message,
            )
        except Exception as finish_exc:
            print(f"could not finalize scanner run: {type(finish_exc).__name__}", file=sys.stderr)
        print(f"scanner failed: {safe_message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
