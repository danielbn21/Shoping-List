"""Real-browser test of automatic matching in Compare prices: names matched by themselves, pre-filled suggestions with one-tap accept,
   English names searched in Hebrew. Needs the app running on 127.0.0.1:3996 with a FRESH data dir:
     DATA_DIR=/tmp/match-data WEB_DIR=web/dist PORT=3996 node server/src/index.js &
     python3 e2e/e2e_match.py
   Price rows are put straight into the price-compare module's database (no portals)."""
import sqlite3, sys, re
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3996"
H = {"X-SL-Client": "web", "Content-Type": "application/json"}
errors = []

def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""), flush=True)
    if not cond: errors.append(name)

def norm(s): return re.sub(r"\s+", " ", re.sub(r"[\"'׳״]", "", s)).strip().replace("ך", "כ").replace("ם", "מ").replace("ן", "נ").replace("ף", "פ").replace("ץ", "צ")

ROWS = {  # chain -> store -> rows: (code, name, description, manufacturer, price, pack_amount, pack_unit)
    "stop_market": ("2", [("7290000000001", "חלב תנובה 3% 1 ליט", "חלב תנובה 3% 1 ליטר", "תנובה", 7.9, 1, "l"),
                          ("7290000000004", "חלב סויה אלפרו 1 ליטר", "", "אלפרו", 14.0, 1, "l"),
                          ("7290000000002", "קוטג 5% תנובה", "קוטג 5% תנובה 250 גרם", "תנובה", 6.5, 250, "g"),
                          ("7290000000005", "אורז בסמטי 1 ק\"ג", "", "סוגת", 12.0, 1000, "g")]),
    "rami_levy": ("1", [("7290000000001", "חלב תנובה 3% 1 ל", "", "תנובה בע\"מ", 7.5, 1, "l")]),
}

with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844}, locale="en-US", timezone_id="Asia/Jerusalem")
    r = ctx.request.post(f"{BASE}/api/setup", headers=H, data={"name": "Admin", "username": "admin", "password": "correct-horse"})
    hid = r.json()["user"]["households"][0]["id"]
    lid = ctx.request.post(f"{BASE}/api/lists", headers=H, data={"householdId": hid, "name": "Groceries"}).json()["id"]
    db = sqlite3.connect("/tmp/match-data/modules/price-compare/data.db")
    for chain, (store, rows) in ROWS.items():
        for code, name, desc, maker, price, amt, unit in rows:
            db.execute("INSERT INTO branch_prices(chain, store_id, code, item_type, name, name_norm, manufacturer, price, unit_price, unit, unit_per, pack_amount, pack_unit, weighted, price_updated, seen_file, description, desc_norm) VALUES (?,?,?,1,?,?,?,?,NULL,'',0,?,?,0,NULL,'20261111000000',?,?)",
                       (chain, store, code, name, norm(name), maker, price, amt, unit, desc, norm(desc)))
        db.execute("INSERT INTO branch_price_state(chain, store_id, file, file_stamp, items, checked_at, updated_at, desc_ok) VALUES (?,?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000,1)", (chain, store, "f", "20261111000000", len(rows)))
        db.execute("INSERT INTO portal_branches(chain, store_id, name, city_key) VALUES (?,?,?,?)", (chain, store, f"branch {store}", "1"))
    db.commit(); db.close()
    for name in ["חלב תנובה 3% 1 ליטר", "חלב", "Cottage cheese", "Zorbleflex"]:
        ctx.request.post(f"{BASE}/api/lists/{lid}/entries", headers=H, data={"name": name, "quantity": 1})
    ctx.request.put(f"{BASE}/api/m/price-compare/lists/{lid}/stores", headers=H, data={"selection": [{"chain": "stop_market", "branchId": "2"}, {"chain": "rami_levy", "branchId": "1"}]})

    page = ctx.new_page()
    page.goto(BASE)
    page.get_by_text("Groceries").first.click()
    page.get_by_role("button", name="Compare prices", exact=True).click()
    page.wait_for_selector("text=Items to match", timeout=30000)
    body = page.locator("section[aria-label]").first.inner_text() if page.locator("section[aria-label]").count() else page.inner_text("body")
    check("the exact name was matched by itself: it is not in the list of items to match", "חלב תנובה 3% 1 ליטר" not in body, body[:300])
    check("generic names get a pre-filled suggestion with a chip and an Accept button", page.get_by_role("button", name="Accept", exact=True).count() >= 2 and page.locator(".chip", has_text=re.compile("Likely|Guess")).count() >= 2)
    check("an English name shows what it was searched as", page.locator("text=/Searched as: .*קוטג/").count() >= 1)
    check("an English name the dictionary cannot translate points to the optional AI key", page.locator("text=save an AI key in Settings").count() == 1, str(page.locator("text=save an AI key in Settings").count()))
    check("Accept all is offered for the chain", page.get_by_role("button", name=re.compile(r"Accept all \d+")).count() >= 1)
    page.screenshot(path="/tmp/shots/20-match-suggestions.png", full_page=True)

    # one tap on one suggestion
    n_before = page.get_by_role("button", name="Accept", exact=True).count()
    page.get_by_role("button", name="Accept", exact=True).first.click()
    page.wait_for_selector("text=/Accepted 1\\./", timeout=10000)
    page.wait_for_timeout(600)
    # the milk's barcode now prices it at Rami Levy as well, so its suggestion there is gone too
    check("accepting a suggestion removes it, and the barcode removes the same product's suggestion at the other chain", page.get_by_role("button", name="Accept", exact=True).count() == n_before - 2, str(page.get_by_role("button", name="Accept", exact=True).count()))
    page.get_by_role("button", name="Accept", exact=True).first.click()
    page.wait_for_timeout(1200)
    check("after accepting, nothing with a suggestion is left; the items nothing fits stay for the user", page.get_by_role("button", name="Accept", exact=True).count() == 0 and page.locator("text=Zorbleflex").count() >= 1)
    # the matched-by-name line is labelled in the branch card
    if page.locator("text=Matched by name").count() == 0:        # the card may already be open
        page.get_by_role("button", name=re.compile("Stop")).first.click()
        page.wait_for_timeout(300)
    check("a line matched by its name says so, and the other chain is priced through the barcode", page.locator("text=Matched by name").count() >= 1)
    page.screenshot(path="/tmp/shots/21-match-after.png", full_page=True)
    br.close()

print("FAILED: " + (", ".join(errors) if errors else "none"))
sys.exit(1 if errors else 0)
