"""Real-browser test of barcode scanning with a fake camera (Chromium plays a video of an EAN-13 barcode as the camera).
   Needs the app running on 127.0.0.1:3997 with a FRESH data dir (DATA_DIR=/tmp/scan-data) and the barcode videos:
     python3 e2e/make_barcodes.py
     DATA_DIR=/tmp/scan-data WEB_DIR=web/dist PORT=3997 node server/src/index.js &
     python3 e2e/e2e_scan.py
   The price file row is put straight into the price-compare module's database (no portals needed)."""
import sqlite3, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3997"
A, B = "7290000000015", "7290000000022"
H = {"X-SL-Client": "web", "Content-Type": "application/json"}
errors = []

def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""), flush=True)
    if not cond: errors.append(name)

def themed(page):
    """The scanner's background must be the app's own page colour (light or dark), not a fixed white."""
    return page.evaluate("""() => { const d = document.querySelector('[role=dialog]'); const probe = document.createElement('div');
      probe.style.background = 'var(--paper)'; document.body.appendChild(probe); const want = getComputedStyle(probe).backgroundColor; probe.remove();
      return [getComputedStyle(d).backgroundColor, want, getComputedStyle(d).color, getComputedStyle(document.body).color]; }""")

def launch(p, video):
    return p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-video-capture={video}"])

def entries(ctx, lid):
    return {e["name"]: e for e in ctx.request.get(f"{BASE}/api/lists/{lid}").json()["entries"]}

with sync_playwright() as p:
    # ---- set up: admin, a list with Milk on it, and one product in the price files
    br = launch(p, "/tmp/barcode_a.y4m")
    ctx = br.new_context(viewport={"width": 390, "height": 844}, locale="en-US", permissions=["camera"])
    r = ctx.request.post(f"{BASE}/api/setup", headers=H, data={"name": "Admin", "username": "admin", "password": "correct-horse"})
    hid = r.json()["user"]["households"][0]["id"]
    lid = ctx.request.post(f"{BASE}/api/lists", headers=H, data={"householdId": hid, "name": "Groceries"}).json()["id"]
    ctx.request.post(f"{BASE}/api/lists/{lid}/entries", headers=H, data={"name": "Milk", "quantity": 1})
    db = sqlite3.connect("/tmp/scan-data/modules/price-compare/data.db")
    db.execute("INSERT INTO branch_prices(chain, store_id, code, item_type, name, name_norm, manufacturer, price, weighted, seen_file) VALUES ('shufersal','1',?,1,'Milk 3% 1L','milk 3% 1l','Tnuva',7.9,0,'20261110000000')", (A,))
    db.commit(); db.close()

    page = ctx.new_page()
    page.goto(BASE)
    page.get_by_text("Groceries").first.click()
    page.wait_for_selector("button:has-text('Scan')")
    check("the Scan button is in the Shop tab", page.locator("button:has-text('Scan')").count() == 1)

    # ---- shopping: scan a product that looks like Milk on the list -> ask once -> tick
    page.get_by_role("button", name="Scan").click()
    page.wait_for_selector("[role=dialog] video")
    bg = themed(page)
    check("1.6.1: in light mode the scanner has the app's page colour and text colour", bg[0] == bg[1] and bg[0] != "rgb(0, 0, 0)" and bg[2] == bg[3], str(bg))
    page.wait_for_selector("text=Is this the same as", timeout=60000)   # the JavaScript reader decodes the fake camera
    check("scanning a product from the price files names it and asks about the similar item", "Milk 3% 1L" in page.locator("[role=alert]").inner_text() and "\"Milk\"" in page.locator("[role=alert]").inner_text(), page.locator("[role=alert]").inner_text())
    page.screenshot(path="/tmp/shots/16-scan-confirm.png")
    page.get_by_role("button", name="Yes, same item").click()
    page.wait_for_selector("text=Milk: ticked")
    check("the item is ticked and the price from the price files is shown", "7.90" in page.locator("[role=dialog] li").first.inner_text(), page.locator("[role=dialog] li").first.inner_text())
    e = entries(ctx, lid)
    check("Milk is in the cart and has the scanned price", e["Milk"]["state"] == "in_cart")
    page.wait_for_timeout(5000)   # the camera still shows the same barcode: it is remembered now, so it is one more in the cart
    page.wait_for_selector("text=Milk: 2 in the cart", timeout=30000)
    check("a remembered barcode needs no question; scanning again adds one to the cart", entries(ctx, lid)["Milk"]["quantity"] >= 2)
    page.screenshot(path="/tmp/shots/17-scan-done.png")
    page.get_by_role("button", name="Done").click()
    check("the scanner closes", page.locator("[role=dialog]").count() == 0)

    # ---- managing: the button is there too and says what it does
    page.get_by_role("button", name="Manage list").click()
    page.wait_for_selector("button:has-text('Scan')")
    page.get_by_role("button", name="Add", exact=True).scroll_into_view_if_needed()
    page.screenshot(path="/tmp/shots/19-manage-add-row.png")
    page.get_by_role("button", name="Scan").click()
    page.wait_for_selector("text=Each scan adds the item to the list.")
    check("Manage list has a Scan button with its own hint", True)
    page.get_by_role("button", name="Done").click()
    add_box, scan_box = page.get_by_role("button", name="Add", exact=True).bounding_box(), page.get_by_role("button", name="Scan").bounding_box()
    check("1.7.2: in Manage list the Scan button is in the same row as Add, between the field and Add", abs((add_box["y"] + add_box["height"] / 2) - (scan_box["y"] + scan_box["height"] / 2)) < 6 and scan_box["x"] < add_box["x"], f"{add_box} {scan_box}")
    page.get_by_role("button", name="Scan").click()
    page.wait_for_selector("text=Each scan adds the item to the list.")
    page.get_by_role("button", name="Done").click()
    ctx.storage_state(path="/tmp/scan-state.json")
    br.close()

    # ---- a second phone: a barcode that is in no price file -> ask for a name -> added already ticked
    br = launch(p, "/tmp/barcode_b.y4m")
    ctx = br.new_context(viewport={"width": 390, "height": 844}, locale="en-US", permissions=["camera"], storage_state="/tmp/scan-state.json", color_scheme="dark")
    page = ctx.new_page()
    page.goto(BASE)
    page.get_by_text("Groceries").first.click()
    page.get_by_role("button", name="Scan").click()
    page.wait_for_selector("text=not in the price files", timeout=60000)
    bg = themed(page)
    check("1.6.1: in dark mode the scanner follows the dark theme", bg[0] == bg[1] and bg[0] not in ("rgb(255, 255, 255)", "rgb(238, 243, 236)") and bg[2] == bg[3], str(bg))
    check("an unknown barcode asks what it is called", page.locator("[role=alert] input").count() == 1)
    page.screenshot(path="/tmp/shots/18-scan-unknown.png")
    page.locator("[role=alert] input").fill("Grandma jam")
    page.get_by_role("button", name="Add", exact=True).click()
    page.wait_for_selector("text=Grandma jam: added to the list and ticked")
    e = entries(ctx, lid)
    check("the new item is on the list, already ticked", e.get("Grandma jam", {}).get("state") == "in_cart", str(list(e)))
    items = ctx.request.get(f"{BASE}/api/households/{hid}/items?listId={lid}").json()["items"]
    check("and it is one of the list's past items", "Grandma jam" in [i["name"] for i in items])
    # typed number (no camera needed): the check digit is verified
    page.get_by_label("Or type the barcode number").fill("1234567890123")
    page.get_by_role("button", name="Look up").click()
    page.wait_for_selector("text=not a valid barcode")
    check("a typed number with a wrong check digit is refused", True)
    br.close()

    # ---- a third phone without a camera (typed numbers only; a camera pointing at a known barcode would keep scanning it)
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844}, locale="en-US", storage_state="/tmp/scan-state.json")
    page = ctx.new_page()
    page.goto(BASE)
    page.get_by_text("Groceries").first.click()

    # ---- 1.7.0: an unknown barcode in Manage list. The scanner used to sit inside the Add form: naming the item submitted that form
    # (the page reloaded to Home and nothing was added). Text typed in the Add field must also stay out of it.
    UNK = "7290000000039"
    page.get_by_role("button", name="Manage list").click()
    page.get_by_placeholder("Add an item").fill("Bread")
    navs = []
    page.on("framenavigated", lambda f: navs.append(f.url) if f == page.main_frame else None)
    page.get_by_role("button", name="Scan").click()
    page.get_by_label("Or type the barcode number").fill(UNK)
    page.get_by_role("button", name="Look up").click()
    page.wait_for_selector("text=not in the price files")
    check("1.7.0: the scanner is drawn in <body>, outside the Add form", page.evaluate("() => !document.querySelector('[role=dialog]').closest('form')"))
    page.locator("[role=alert] input").fill("Tehina jar")
    page.locator("[role=alert]").get_by_role("button", name="Add", exact=True).click()
    page.wait_for_selector("text=Tehina jar: added to the list")
    check("1.7.0: naming an unknown barcode in Manage list does not leave the list (no page reload)", not navs and page.locator("[role=dialog]").count() == 1, str(navs))
    e = entries(ctx, lid)
    check("1.7.0: the item was added, and the text typed in the Add field was not", "Tehina jar" in e and "Bread" not in e, str(list(e)))

    # ---- 1.7.0: rename what was just scanned; the barcode stays attached
    page.get_by_role("button", name="Edit name").click()
    page.get_by_label("Item name").fill("Tehina (family jar)")
    page.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_selector("text=is now")
    e = entries(ctx, lid)
    check("1.7.0: renaming the scanned item changes it on the list", "Tehina (family jar)" in e and "Tehina jar" not in e, str(list(e)))
    page.get_by_label("Or type the barcode number").fill(UNK)
    page.get_by_role("button", name="Look up").click()
    page.wait_for_selector("text=Tehina (family jar): now 2", timeout=10000)
    e = entries(ctx, lid)
    check("1.7.0: scanning the same barcode again finds the renamed item, not a new one", len([n for n in e if n.startswith("Tehina")]) == 1, str(list(e)))
    # a name another item has is refused with a message, the dialog stays
    page.get_by_role("button", name="Edit name").click()
    page.get_by_label("Item name").fill("Grandma jam")
    page.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_selector("text=already exists")
    check("1.7.0: a name that another item already has is refused", "Tehina (family jar)" in entries(ctx, lid))
    page.screenshot(path="/tmp/shots/20-scan-rename.png")
    page.get_by_role("button", name="Cancel").click()
    br.close()

print("FAILED: " + (", ".join(errors) if errors else "none"))
sys.exit(1 if errors else 0)
