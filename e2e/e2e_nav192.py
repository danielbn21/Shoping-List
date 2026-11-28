# Navigation test (1.9.2): the shared header and back arrow on every screen, the browser back button and Esc, refresh keeping the place,
# the menu grouped by scope, "where I left off", quick add in Shop, the Shopper's limits, and the tablet and desktop layouts.
# Needs the app on 127.0.0.1:3993 with a FRESH data dir:
#   DATA_DIR=/tmp/nav-data WEB_DIR=web/dist PORT=3993 node server/src/index.js &
# Then:  python e2e/e2e_nav192.py   (screenshots go to /tmp/shots)
from playwright.sync_api import sync_playwright
import sys

BASE = "http://127.0.0.1:3993"
H = {"X-SL-Client": "web", "Content-Type": "application/json"}
errors = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""), flush=True)
    if not cond:
        errors.append(name)


with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844}, locale="en-US")
    api = lambda m, path, body=None: getattr(ctx.request, m)(BASE + "/api" + path, headers=H, data=body)
    hid = api("post", "/setup", {"name": "Admin", "username": "admin", "password": "correct-horse"}).json()["user"]["households"][0]["id"]
    lid = api("post", "/lists", {"householdId": hid, "name": "Groceries"}).json()["id"]
    lid2 = api("post", "/lists", {"householdId": hid, "name": "Pharmacy"}).json()["id"]
    api("post", f"/lists/{lid}/entries", {"name": "Bread", "quantity": 1})
    sam = api("post", "/admin/users", {"name": "Sam", "username": "sam", "password": "shopper-pass1", "householdId": hid}).json()["id"]
    api("put", f"/lists/{lid}/members/{sam}", {"role": "viewer"})

    page = ctx.new_page()
    page.set_default_timeout(8000)
    console = []
    page.on("console", lambda m: console.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console.append(str(e)))
    no_overflow = lambda: page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    menu = lambda: page.get_by_role("button", name="Menu", exact=True).click()
    arrow = lambda name: page.locator(".screenhead").get_by_role("button", name=name, exact=True)
    h = lambda: page.locator(".screenhead h1").inner_text()
    hash_ = lambda: page.evaluate("location.hash")

    # ---- Home has no arrow; every screen below it has one in the same header
    page.goto(BASE)
    page.wait_for_selector(".list-card")
    check("Home: the shared header without a back arrow, with the menu", page.locator(".screenhead").count() == 1 and page.locator(".screenhead button", has_text="←").count() == 0 and page.get_by_role("button", name="Menu", exact=True).count() == 1)
    page.locator(".list-card", has_text="Groceries").click()
    page.wait_for_selector(".tabs")
    check("opening a list: the address says which list and tab", hash_() == f"#/list/{lid}/tab/shop", hash_())
    check("the list has the arrow to All lists", arrow("All lists").count() == 1)

    menu(); page.get_by_role("menuitem", name="Settings").click()
    check("Settings: arrow, title, scope line", arrow("Back").count() == 1 and h() == "Settings" and "Me" in page.locator(".screenhead .scope").inner_text())
    arrow("Back").click()
    check("the arrow from Settings returns to the list it was opened from", hash_() == f"#/list/{lid}/tab/shop", hash_())

    menu(); page.get_by_role("menuitem", name="Administration").click()
    check("Administration (phone): a list of four areas, with the arrow", arrow("Back").count() == 1 and page.locator(".arealist button").all_inner_texts()[0:4] != [] and page.locator(".arealist button").count() == 4, str(page.locator(".arealist button").all_inner_texts()))
    page.locator(".arealist button", has_text="People").click()
    check("an area has the arrow back to Administration", arrow("Back to Administration").count() == 1 and h() == "People")
    page.locator(".seg button", has_text="Households").click()
    page.locator("button.card").first.click()
    check("a household inside Administration: still the arrow, and the address names it", arrow("Back to Administration").count() == 1 and "/households/" in hash_(), hash_())
    page.go_back()
    check("the browser's Back goes to the households list, not out of the app", page.locator("button.card").count() >= 1 and "/households" in hash_() and not hash_().rstrip("/").endswith(tuple("0123456789")), hash_())
    page.go_back(); page.go_back()
    check("...and again, step by step, back to the list", hash_() == f"#/list/{lid}/tab/shop", hash_())

    menu(); page.get_by_role("menuitem", name="People and access").click()
    check("a list page keeps the arrow and the menu", arrow("Back to Groceries").count() == 1 and page.get_by_role("button", name="Menu", exact=True).count() == 1 and hash_().endswith("/page/people"))
    page.reload(); page.wait_for_selector(".screenhead")
    check("a refresh keeps the place (same page of the same list)", h() == "People and access" and hash_().endswith("/page/people"), h())
    page.go_back()
    check("the system back gesture leaves the page, not the app", page.locator(".tabs").count() == 1, hash_())

    menu(); page.get_by_role("menuitem", name="Members and invites").click()
    check("a household page opened from a list: arrow back to the list", arrow("Back to Groceries").count() == 1 and h() == "Members and invites")
    arrow("Back to Groceries").click()
    page.wait_for_selector(".tabs")
    page.keyboard.press("Escape")
    page.wait_for_selector(".list-card")
    check("Esc goes back, like the arrow (list to Home)", page.locator(".list-card").count() == 2, hash_())

    page.get_by_role("button", name="New list").first.click()
    check("New list: the arrow and the Cancel button both exist", arrow("Back").count() == 1 and page.get_by_role("button", name="Cancel").count() == 1)
    page.get_by_role("button", name="Cancel").click()
    page.wait_for_selector(".list-card")
    check("Cancel returns to Home", page.locator(".list-card").count() == 2)
    menu(); page.get_by_role("menuitem", name="New household").click()
    check("New household: the arrow", arrow("Back").count() == 1)
    arrow("Back").click()
    page.wait_for_selector(".list-card")
    menu(); page.get_by_role("menuitem", name="Export purchases").click()
    check("a household page from Home has the arrow and the household scope", arrow("Back").count() == 1 and "Household" in page.locator(".screenhead .scope").inner_text())
    arrow("Back").click()
    page.wait_for_selector(".list-card")
    check("every screen above kept the page free of sideways scrolling", no_overflow())

    # ---- the menu on Home: Household, Me, Server
    menu()
    heads = [x.lower() for x in page.locator(".menu-heading").all_inner_texts()]
    check("Home menu groups: household, me, server", [x.split(" · ")[0] for x in heads] == ["household", "me", "server (admins only)"], str(heads))
    page.keyboard.press("Escape")

    # ---- where a list opens
    page.locator(".list-card", has_text="Groceries").click()
    page.get_by_role("button", name="Manage list", exact=True).click()
    page.wait_for_timeout(1000)   # the place is saved a moment later
    p2 = ctx.new_page(); p2.set_default_timeout(8000); p2.goto(BASE); p2.wait_for_selector(".tabs")
    check("'Where I left off' (the default): the app opens the last list on the tab used last", p2.evaluate("location.hash") == f"#/list/{lid}/tab/manage" and p2.get_by_role("button", name="Manage list", exact=True).get_attribute("aria-pressed") == "true", p2.evaluate("location.hash"))
    p2.get_by_role("button", name="All lists", exact=True).click()
    check("the arrow from a list opened at start goes to Home (and Home stays)", p2.locator(".list-card").count() == 2)
    p2.close()
    api("put", "/me/prefs", {"openMode": "shop"})
    p2 = ctx.new_page(); p2.set_default_timeout(8000); p2.goto(BASE); p2.wait_for_selector(".list-card")
    p2.locator(".list-card", has_text="Groceries").click(); p2.wait_for_selector(".tabs")
    check("'Always Shop': a list opens on Shop whatever was used last", p2.get_by_role("button", name="Shop", exact=True).get_attribute("aria-pressed") == "true")
    p2.close()
    api("put", "/me/prefs", {"openMode": "manage"})
    p2 = ctx.new_page(); p2.set_default_timeout(8000); p2.goto(BASE); p2.wait_for_selector(".list-card")
    p2.locator(".list-card", has_text="Pharmacy").click(); p2.wait_for_selector(".tabs")
    check("'Always Manage': a list opens on Manage", p2.get_by_role("button", name="Manage list", exact=True).get_attribute("aria-pressed") == "true")
    p2.close()
    bread = [e for e in api("get", f"/lists/{lid}").json()["entries"] if e["name"] == "Bread"][0]["id"]
    api("post", f"/entries/{bread}/check", {"checked": True})
    p2 = ctx.new_page(); p2.set_default_timeout(8000); p2.goto(BASE); p2.wait_for_selector(".list-card")
    p2.locator(".list-card", has_text="Groceries").click(); p2.wait_for_selector(".tabs")
    check("a trip in progress (something ticked) always opens on Shop, even with 'Always Manage'", p2.get_by_role("button", name="Shop", exact=True).get_attribute("aria-pressed") == "true")
    p2.close()
    api("post", f"/entries/{bread}/check", {"checked": False})
    api("put", "/me/prefs", {"openMode": "last"})

    # ---- quick add in Shop
    page.goto(BASE + f"/#/list/{lid}/tab/shop"); page.reload(); page.wait_for_selector(".tabs")
    page.get_by_role("button", name="Shop", exact=True).click()
    search = page.locator("input[type=search]")
    search.fill("bread")
    check("an item that is on the list gets no add row", page.locator(".quickadd").count() == 0)
    search.fill("Oat milk")
    check("a search with no match offers to add it", page.locator(".quickadd").inner_text().strip().endswith("Add “Oat milk” to the list") or "Oat milk" in page.locator(".quickadd").inner_text())
    page.locator(".quickadd").click()
    page.wait_for_timeout(700)
    names = [e["name"] for e in api("get", f"/lists/{lid}").json()["entries"]]
    check("one tap adds it and the search is cleared, still in Shop", "Oat milk" in names and search.input_value() == "" and page.locator(".tabs").count() == 1, str(names))

    # ---- Settings: three sections, the new preference
    menu(); page.get_by_role("menuitem", name="Settings").click()
    check("Settings: Account, Preferences, Modules", [x.lower() for x in page.locator(".sectionhead").all_inner_texts()] == ["account", "preferences", "modules"])
    page.get_by_label("When I open a list").select_option(label="Always Manage")
    page.wait_for_timeout(600)
    pref = api("get", "/me").json()["user"]["prefs"]
    check("'When I open a list' is saved on the server", pref.get("openMode") == "manage", str(pref))
    page.get_by_label("When I open a list").select_option(label="Where I left off")
    page.wait_for_timeout(400)
    check("there is one Sign out (in the menu), not a second button on the page", page.get_by_role("button", name="Sign out").count() == 0)
    arrow("Back").click()

    # ---- List name and colour; typed-name delete
    tmp = api("post", "/lists", {"householdId": hid, "name": "Temp list"}).json()["id"]
    page.goto(BASE + f"/#/list/{tmp}/page/listsettings"); page.reload(); page.wait_for_selector(".screenhead")
    check("the page is titled Name and colour", h() == "Name and colour")
    page.locator(".swatch").nth(2).click(); page.wait_for_timeout(500)
    check("a colour can be changed here", api("get", f"/lists/{tmp}").json()["list"]["color"] != "green")
    page.locator("summary", has_text="Delete list").click()
    btn = page.get_by_role("button", name="Delete list", exact=True)
    check("Delete list needs the list's name typed", btn.is_disabled())
    page.get_by_label("Type the list name").fill("Temp list")
    check("...and is enabled once it matches", btn.is_enabled())
    btn.click(); page.wait_for_selector(".list-card")
    check("deleting returns to Home and the list is gone", page.locator(".list-card", has_text="Temp list").count() == 0)

    # ---- the Shopper: no Manage, no quick add, a menu with only Me
    sctx = br.new_context(viewport={"width": 390, "height": 844}, locale="en-US")
    sapi = lambda m, path, body=None: getattr(sctx.request, m)(BASE + "/api" + path, headers=H, data=body)
    r1 = sapi("post", "/auth/login", {"login": "sam", "password": "shopper-pass1"})
    r2 = sapi("post", "/auth/change-password", {"currentPassword": "shopper-pass1", "newPassword": "shopper-pass2"})
    print("shopper sign-in:", r1.status, r2.status, r2.text()[:120] if r2.status != 200 else "")
    sp = sctx.new_page(); sp.set_default_timeout(8000)
    sp.goto(BASE + f"/#/list/{lid}"); sp.wait_for_selector(".tabs")
    check("a Shopper sees only Shop and History", sp.locator(".tabs > button").count() == 2 and sp.get_by_role("button", name="Manage list", exact=True).count() == 0, str(sp.locator(".tabs > button").all_inner_texts()))
    sp.locator("input[type=search]").fill("Zzzz")
    check("a Shopper gets no quick-add row", sp.locator(".quickadd").count() == 0)
    sp.get_by_role("button", name="Menu", exact=True).click()
    sheads = [x.lower() for x in sp.locator(".menu-heading").all_inner_texts()]
    check("a Shopper's menu is only Me", sheads == ["me"] and sp.get_by_role("menuitem").all_inner_texts() == ["Settings", "Sign out"], str(sheads))
    sp.keyboard.press("Escape")
    sp.goto(BASE + f"/#/list/{lid}/page/people"); sp.reload(); sp.wait_for_selector(".tabs")
    check("a Shopper typing a Manage address is sent back to the list", "/page/" not in sp.evaluate("location.hash"), sp.evaluate("location.hash"))
    sctx.close()

    # ---- a small phone (360 x 640): long names, no sideways scrolling anywhere
    api("patch", f"/lists/{lid}", {"name": "A very long list name that keeps going and going for the whole week"})
    page.set_viewport_size({"width": 360, "height": 640})
    page.goto(BASE + f"/#/list/{lid}/tab/shop"); page.reload(); page.wait_for_selector(".tabs")
    hh = page.locator(".screenhead").bounding_box()["height"]
    check("a long list name is cut with an ellipsis; the header keeps its height", page.locator(".screenhead h1").evaluate("e => e.scrollWidth > e.clientWidth") and hh < 80, str(hh))
    check("the arrow and the menu stay on screen", page.locator(".screenhead .iconbtn").first.bounding_box()["x"] >= 0 and page.get_by_role("button", name="Menu", exact=True).bounding_box()["x"] + 30 <= 360)
    menu()
    pb = page.locator(".menu-panel").bounding_box()
    check("the long menu scrolls inside the sheet and fits the small screen", pb["y"] >= 0 and pb["y"] + pb["height"] <= 641 and no_overflow(), str(pb))
    page.keyboard.press("Escape")
    for hs in [f"#/list/{lid}/tab/manage", f"#/list/{lid}/tab/history", f"#/list/{lid}/page/stores", f"#/list/{lid}/page/csv", "#/settings", "#/admin/people/users", "#/admin/server/config", "#/admin/audit", "#/admin/modules"]:
        page.evaluate(f"location.hash = '{hs}'"); page.wait_for_timeout(500)
        check(f"360 px: no sideways scrolling on {hs.lstrip('#/')}", no_overflow())
    api("patch", f"/lists/{lid}", {"name": "Groceries"})

    # ---- a tablet (800 px): sidebars from 768, Manage still one column
    page.set_viewport_size({"width": 800, "height": 1000})
    page.goto(BASE + "/#/settings"); page.reload(); page.wait_for_selector(".sidelayout")
    check("tablet: Settings has a sidebar and shows one section", page.locator(".sidenav button").count() == 3 and page.locator(".sectionhead").count() == 0 and page.locator(".sidenav button[aria-current=page]").inner_text() == "Account")
    page.locator(".sidenav button", has_text="Preferences").click()
    check("tablet: picking a section in the sidebar switches the content", page.locator(".sidecontent select").count() >= 4 and page.get_by_label("When I open a list").count() == 1 and "preferences" in hash_(), hash_())
    page.goto(BASE + f"/#/list/{lid}/tab/manage"); page.reload(); page.wait_for_selector(".tabs")
    check("tablet: Manage is still one column with the switch", page.locator(".manage-cols").count() == 0 and page.locator(".seg").count() == 1)

    # ---- a desktop (1280 px)
    page.set_viewport_size({"width": 1280, "height": 900})
    page.goto(BASE + f"/#/list/{lid}/tab/manage"); page.reload(); page.wait_for_selector(".manage-cols")
    check("desktop: Manage shows Past items and On the list side by side, with no switch", page.locator(".manage-cols > section").count() == 2 and page.locator(".seg").count() == 0)
    bx = [page.locator(".manage-cols > section").nth(i).bounding_box() for i in range(2)]
    check("desktop: the two columns share the width", bx[0]["x"] < bx[1]["x"] and abs(bx[0]["width"] - bx[1]["width"]) < 60 and bx[1]["x"] + bx[1]["width"] <= 1280, str(bx))
    page.screenshot(path="/tmp/shots/40-desktop-manage.png")
    page.goto(BASE + f"/#/list/{lid}/page/stores"); page.reload(); page.wait_for_selector(".sidelayout")
    groups = [x.lower() for x in page.locator(".sidenav .menu-heading").all_inner_texts()]
    check("desktop: a list page has the same groups in a sidebar, the current page marked", [g.split(" · ")[0] for g in groups] == ["this list", "household", "me", "server (admins only)"] and page.locator(".sidenav button[aria-current=page]").inner_text().startswith("Stores"), str(groups))
    crumbs = page.locator(".crumbs").inner_text()
    check("desktop: a breadcrumb names where you are, and the arrow is still there", "Lists" in crumbs and "Groceries" in crumbs and "Stores" in crumbs and arrow("Back to Groceries").count() == 1, crumbs)
    page.locator(".crumbs button", has_text="Groceries").click()
    check("a breadcrumb link goes there", page.locator(".tabs").count() == 1 and "/page/" not in hash_(), hash_())
    page.screenshot(path="/tmp/shots/41-desktop-list.png")
    page.goto(BASE + "/#/admin"); page.reload(); page.wait_for_selector(".sidelayout")
    check("desktop: Administration opens on People with a four-area sidebar", page.locator(".sidenav button").count() == 4 and page.locator(".sidenav button[aria-current=page]").inner_text() == "People" and page.locator(".seg button").count() == 2)
    page.screenshot(path="/tmp/shots/42-desktop-admin.png")
    page.goto(BASE + "/#/settings"); page.reload(); page.wait_for_selector(".sidelayout")
    page.locator("input, select").first.focus(); page.keyboard.press("Escape")
    check("Esc inside a field does not leave the screen", hash_().startswith("#/settings"), hash_())
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Escape")
    check("desktop: Esc goes back", not hash_().startswith("#/settings"), hash_())
    check("desktop: no sideways scrolling", no_overflow())

    # ---- Hebrew: the arrow mirrors on the new screens
    api("patch", "/me", {"language": "he"})
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(BASE + "/#/settings"); page.reload(); page.wait_for_selector(".screenhead")
    check("Hebrew: Settings has its arrow pointing right and sections", page.locator(".screenhead .iconbtn").first.inner_text() == "→" and page.locator(".sectionhead").count() == 3)
    page.goto(BASE + f"/#/list/{lid}/page/stores"); page.reload(); page.wait_for_selector(".screenhead")
    check("Hebrew: a list page keeps arrow and menu and fits the screen", page.locator(".screenhead .iconbtn").count() == 2 and no_overflow())
    page.screenshot(path="/tmp/shots/43-he-page.png")
    br.close()

print("console errors:", [c for c in console if "favicon" not in c][:5])
print("FAILED:", errors if errors else "none")
sys.exit(1 if errors else 0)
