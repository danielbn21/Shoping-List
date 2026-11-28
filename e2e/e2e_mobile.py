# Phone layout test (1.7.2): the burger menu, the bottom tab bar, the pages of a list, the new Manage list; 1.9.2: the shared header and the scope-grouped menu.
# Needs the app on 127.0.0.1:3995 with a FRESH data dir:
#   DATA_DIR=/tmp/mobile-data WEB_DIR=web/dist PORT=3995 node server/src/index.js &
# Then:  python e2e/e2e_mobile.py   (screenshots go to /tmp/shots)
from playwright.sync_api import sync_playwright
import sys

BASE = "http://127.0.0.1:3995"
H = {"X-SL-Client": "web", "Content-Type": "application/json"}
errors = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""), flush=True)
    if not cond:
        errors.append(name)


with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844}, locale="en-US", timezone_id="Asia/Jerusalem", device_scale_factor=2)
    api = lambda m, path, body=None: getattr(ctx.request, m)(BASE + "/api" + path, headers=H, data=body)
    hid = api("post", "/setup", {"name": "Admin", "username": "admin", "password": "correct-horse"}).json()["user"]["households"][0]["id"]
    lid = api("post", "/lists", {"householdId": hid, "name": "Groceries"}).json()["id"]
    cats = api("get", f"/lists/{lid}").json()["categories"]
    cid = lambda prefix: [c["id"] for c in cats if c["nameEn"].startswith(prefix)][0]
    for name, cat in [("Milk 3%", cid("Dairy")), ("Cottage cheese", cid("Dairy")), ("Tomatoes", cid("Produce")), ("Cucumbers", cid("Produce"))]:
        api("post", f"/lists/{lid}/entries", {"name": name, "quantity": 1, "categoryId": cat})
    for e in api("get", f"/lists/{lid}").json()["entries"]:
        api("delete", f"/entries/{e['id']}")          # off the list = past items
    api("post", f"/lists/{lid}/entries", {"name": "Bread", "quantity": 1})

    page = ctx.new_page()
    page.set_default_timeout(8000)
    page.on("dialog", lambda d: d.accept())
    console = []
    page.on("console", lambda m: console.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console.append(str(e)))
    no_overflow = lambda: page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    page.goto(BASE)
    page.wait_for_selector(".tabs")

    # ---- the list screen: one slim header, the tabs at the bottom edge
    check("no separate app bar above a list (Settings and Admin are in the menu)", page.locator(".topbar").count() == 0 and page.locator("nav.nav").count() == 0)
    ys = [page.locator(sel).bounding_box() for sel in ["button[aria-label='All lists']", ".screenhead h1", "button[aria-label='Menu']"]]
    check("the header is one row: back, name, menu", len({round(b["y"] + b["height"] / 2, -1) for b in ys}) == 1, str(ys))
    bar = page.locator(".tabs").bounding_box()
    check("the tabs are one bar fixed at the bottom edge", abs(bar["y"] + bar["height"] - 844) < 2 and bar["height"] < 90 and page.locator(".tabs > button").count() == 4, str(bar))
    check("every tab has an icon and a short label", page.locator(".tabs .ico svg").count() == 4 and page.locator(".tabs .lbl-short").all_inner_texts() == ["Shop", "Manage", "Compare prices", "History"], str(page.locator(".tabs .lbl-short").all_inner_texts()))
    check("no horizontal overflow (Shop)", no_overflow())
    page.screenshot(path="/tmp/shots/30-mobile-shop.png")
    check("the Finish trip bar keeps clear of the tab bar", page.evaluate("parseFloat(getComputedStyle(document.querySelector('.shopbar') || document.body).bottom) || 0") >= 0 and page.evaluate("""() => { const r = document.createElement('div'); r.className = 'shopbar'; document.body.appendChild(r); const b = parseFloat(getComputedStyle(r).bottom); r.remove(); return b; }""") >= bar["height"] - 2)

    # ---- the burger menu: a sheet from the bottom edge, grouped by scope (1.9.2)
    page.get_by_role("button", name="Menu", exact=True).click()
    sheet = page.locator(".menu-panel").bounding_box()
    check("the menu opens as a sheet from the bottom edge, full width", abs(sheet["y"] + sheet["height"] - 844) < 2 and sheet["width"] >= 388, str(sheet))
    heads = [h.lower() for h in page.locator(".menu-heading").all_inner_texts()]   # drawn in capitals by the style sheet
    check("the menu groups by scope: this list, household, me, server", [h.split(" · ")[0] for h in heads] == ["this list", "household", "me", "server (admins only)"] and heads[0] == "this list · groceries", str(heads))
    items = page.get_by_role("menuitem").all_inner_texts()
    check("list pages first, then household pages, then Settings, Sign out and Administration; Delete list is no longer in the menu", [i.split("\n")[0].strip() for i in items][:4] == ["Name and colour", "People and access", "Compare prices", "Stores"] and items[-3:] == ["Settings", "Sign out", "Administration"] and "Delete list" not in items and "Members and invites" in items and "Items and CSV" in items, str(items))
    check("the menu fits the screen width", no_overflow())
    page.screenshot(path="/tmp/shots/31-mobile-menu.png")
    page.keyboard.press("Escape")
    check("Escape closes the menu", page.locator(".menu-panel").count() == 0)
    page.get_by_role("button", name="Menu", exact=True).click()
    page.locator(".menu-backdrop").click(position={"x": 20, "y": 20})
    check("a tap outside closes the menu", page.locator(".menu-panel").count() == 0)

    # ---- a page of the menu replaces the tabs; the header keeps its back arrow and the menu
    page.get_by_role("button", name="Menu", exact=True).click()
    page.get_by_role("menuitem", name="People and access").click()
    check("a page of the menu shows its title and the list's name, without the tab bar", page.locator(".screenhead h1").inner_text() == "People and access" and "Groceries" in page.locator(".screenhead").inner_text() and page.locator(".tabs").count() == 0)
    check("the page keeps the header's back arrow and menu (nothing replaces them)", page.get_by_role("button", name="Back to Groceries").count() == 1 and page.get_by_role("button", name="Menu", exact=True).count() == 1)
    check("no horizontal overflow (a page of the menu)", no_overflow())
    page.get_by_role("button", name="Back to Groceries").click()
    check("back returns to the tab you came from, with the bar", page.get_by_role("button", name="Shop", exact=True).get_attribute("aria-pressed") == "true" and page.locator(".tabs").count() == 1)

    # ---- Manage list
    page.get_by_role("button", name="Manage list", exact=True).click()
    seg = page.locator(".seg button")
    check("a switch: Past items | On the list with the number to buy", seg.all_inner_texts() == ["Past items", "On the list · 1"] and seg.first.get_attribute("aria-pressed") == "true", str(seg.all_inner_texts()))
    page.get_by_label("Item", exact=True).fill("Eggs")
    check("typing opens the Add panel (category, quantity, note); Add sits at its end", page.locator(".addpanel").get_by_label("Category").count() == 1 and page.locator(".addpanel").get_by_label("Quantity").count() == 1 and page.locator(".addpanel > button").inner_text() == "Add")
    page.get_by_role("button", name="Add", exact=True).click()
    page.wait_for_function("[...document.querySelectorAll('.seg button')].some(b => b.textContent === 'On the list · 2')")
    check("adding updates the count on the switch", True)
    page.wait_for_timeout(500)
    row_y = lambda sel: round(page.locator(sel).bounding_box()["y"] + page.locator(sel).bounding_box()["height"] / 2)
    check("search and the category filter share one row", abs(row_y(".filterrow input[type=search]") - row_y(".filterrow select")) < 4)
    names = lambda: [n.strip() for n in page.locator(".past-name strong").all_inner_texts()]
    check("past items are listed (the item just added is on the list, so it shows too)", {"Milk 3%", "Cottage cheese", "Tomatoes", "Cucumbers"} <= set(names()), str(names()))
    page.locator(".filterrow select").select_option(label="Dairy & eggs")
    page.wait_for_timeout(300)
    check("the category filter narrows the list", set(names()) >= {"Milk 3%", "Cottage cheese"} and "Tomatoes" not in names(), str(names()))
    page.locator(".filterrow select").select_option("")
    row = page.locator(".past", has_text="Tomatoes").first
    check("a row is one compact line until it is tapped", row.locator(".qty").count() == 0 and row.locator(".past-row").bounding_box()["height"] < 80)
    row.locator(".past-main").click()
    row.get_by_role("button", name="More").click()
    row.get_by_placeholder("Note for this trip").fill("ripe")
    row.get_by_role("button", name="Add 2 to list").click()
    page.wait_for_timeout(700)
    mine = [e for e in api("get", f"/lists/{lid}").json()["entries"] if e["name"] == "Tomatoes"]
    check("the open row adds with its quantity and its note", len(mine) == 1 and mine[0]["quantity"] == 2 and (mine[0].get("note") or "") == "ripe", str(mine))
    check("no horizontal overflow (Manage list)", no_overflow())
    page.screenshot(path="/tmp/shots/32-mobile-manage.png")

    # ---- the keyboard hides the bar; a wide screen keeps tabs at the top
    page.evaluate("document.documentElement.classList.add('kbd')")
    check("the tab bar steps aside while the keyboard is up", not page.locator(".tabs").is_visible())
    page.evaluate("document.documentElement.classList.remove('kbd')")
    page.set_viewport_size({"width": 1100, "height": 800})
    page.wait_for_timeout(300)
    tabs = page.locator(".tabs")
    check("on a wide screen the tabs stay a row at the top with full names and no icons", tabs.evaluate("e => getComputedStyle(e).position") != "fixed" and tabs.bounding_box()["y"] < 200 and page.locator(".tabs .ico").first.is_hidden() and "Manage list" in tabs.inner_text())
    page.get_by_role("button", name="Menu", exact=True).click()
    check("on a wide screen the menu is a small popover", page.locator(".menu-panel").bounding_box()["width"] < 400)
    page.keyboard.press("Escape")
    page.set_viewport_size({"width": 390, "height": 844})

    # ---- Settings and Admin come from the menu; their screens share the header: back arrow, title, the same menu
    page.get_by_role("button", name="Menu", exact=True).click()
    page.get_by_role("menuitem", name="Settings").click()
    check("Settings opens from the menu with the shared header (arrow, title, scope line, menu)", page.locator(".topbar").count() == 0 and page.locator(".screenhead h1").inner_text() == "Settings" and page.get_by_role("button", name="Back", exact=True).count() == 1 and "Me" in page.locator(".screenhead .scope").inner_text())
    check("Settings has three labeled sections", [h.lower() for h in page.locator(".sectionhead").all_inner_texts()] == ["account", "preferences", "modules"], str(page.locator(".sectionhead").all_inner_texts()))
    page.get_by_role("button", name="Menu", exact=True).click()
    check("...whose menu offers Me (Settings marked, Sign out) and Server", [i.strip() for i in page.get_by_role("menuitem").all_inner_texts()] == ["Settings", "Sign out", "Administration"] and page.get_by_role("menuitem", name="Settings").get_attribute("aria-current") == "page")
    page.keyboard.press("Escape")
    page.get_by_role("button", name="Back", exact=True).click()
    page.wait_for_selector(".list-card, .tabs")

    # ---- Hebrew: right to left, the bar and the sheet mirror
    api("patch", "/me", {"language": "he"})
    page.reload()
    page.wait_for_function("document.querySelectorAll('.tabs > button').length === 4")
    xs = [page.locator(f".tabs > button >> nth={i}").bounding_box()["x"] for i in range(4)]
    check("Hebrew: the tab bar runs right to left (Shop on the right)", xs == sorted(xs, reverse=True), str(xs))
    check("Hebrew: the back arrow points right and the menu is on the left of the title", page.locator("button[aria-label='All lists'], button[aria-label='כל הרשימות']").first.inner_text() == "→" and page.locator(".screenhead button").last.bounding_box()["x"] < page.locator(".screenhead h1").bounding_box()["x"])
    page.get_by_role("button", name="תפריט", exact=True).click()
    check("Hebrew: the menu sheet fits the screen", no_overflow() and page.locator(".menu-heading").count() == 4)
    page.screenshot(path="/tmp/shots/33-mobile-menu-he.png")
    page.keyboard.press("Escape")
    page.locator(".tabs > button >> nth=1").click()
    page.wait_for_selector(".seg")
    check("Hebrew: Manage list fits (no horizontal overflow)", no_overflow())
    br.close()

print("console errors:", [c for c in console if "favicon" not in c][:5])
print("FAILED:", errors if errors else "none")
sys.exit(1 if errors else 0)
