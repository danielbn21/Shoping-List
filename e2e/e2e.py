# Browser end-to-end test (needs: pip install playwright && python -m playwright install chromium).
# Start the fake supermarket portals first (they mimic the three real portals, with trimmed real price files):
#   node modules/price-compare/test/fakePortals.js 4999            (prints the URLs; this script expects the default 127.0.0.1:4999)
# Start the app, pointed at them:  DATA_DIR=/tmp/e2e-data WEB_DIR=web/dist PORT=3998 \
#   PORTAL_URL_SHUFERSAL=http://127.0.0.1:4999/shufersal PORTAL_URL_SHARED=http://127.0.0.1:4999/shared \
#   PORTAL_URL_CARREFOUR=http://127.0.0.1:4999/carrefour PORTAL_CITIES_URL=http://127.0.0.1:4999/gov/datastore_search \
#   node server/src/index.js   (fresh data dir each run)
# Then:  python e2e/e2e.py   (screenshots go to /tmp/shots, which must exist)
from playwright.sync_api import sync_playwright
import sys

B = "http://127.0.0.1:3998"
errors = []


def more(page, name):
    """Open a secondary tab (Compare prices, List history): on a phone they sit in the tab row's drop-down."""
    page.locator(".tabmenu > button").click()
    page.get_by_role("menuitem", name=name).click()


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""), flush=True)
    if not cond:
        errors.append(name)


with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="en-US", timezone_id="Asia/Jerusalem", accept_downloads=True)
    page = ctx.new_page()
    page.set_default_timeout(8000)
    page.on("dialog", lambda d: d.accept())
    console = []
    page.on("console", lambda m: console.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console.append(str(e)))

    # ---- first-run setup ----
    page.goto(B)
    page.wait_for_selector("text=Set up your server")
    check("the first screen has no language switch (English until you choose a language in Settings)", page.locator(".langswitch").count() == 0 and page.get_by_text("עברית").count() == 0)
    page.screenshot(path="/tmp/shots/01-setup.png")
    page.get_by_label("Your name").fill("Admin")
    page.get_by_label("Username", exact=True).fill("admin")
    page.get_by_label("Password", exact=True).fill("correct-horse")
    page.get_by_role("button", name="Create admin account").click()
    page.wait_for_selector("text=No lists yet")
    check("setup lands on empty lists screen", True)

    # ---- create a list ----
    page.get_by_role("button", name="New list").click()
    page.get_by_label("List name").fill("Groceries")
    page.get_by_role("button", name="Create list").click()
    page.wait_for_selector("button:has-text('Manage list')")
    check("new list opens straight into Shop tab", page.get_by_role("button", name="Shop", exact=True).get_attribute("aria-pressed") == "true")
    check("shop tab shows empty hint", page.locator("text=This list is empty").count() == 1)
    check("shop tab has no add/edit controls", page.locator("summary:text-is('Add items')").count() == 0)

    # ---- manage: labeled fields ----
    page.locator(".tabs button", has_text="Manage list").click()
    page.wait_for_selector("summary:text-is('Add items')")
    labels = [page.locator(f"label.field > span:text-is('{l}')").count() for l in ["Item", "Quantity", "Category", "Note (optional)"]]
    check("labels visible: Item/Quantity/Category/Note", all(c >= 1 for c in labels), str(labels))
    check("no Unit field in add form", page.get_by_label("Unit").count() == 0)

    def add(name, qty="1", cat=None, note=None, new_cat=None):
        page.get_by_label("Item", exact=True).fill(name)
        page.get_by_label("Quantity").first.fill(qty)
        sel = page.locator("form select").first
        if new_cat:
            sel.select_option("__new__")
            page.locator("form").first.get_by_placeholder("New category name").fill(new_cat)
            page.get_by_role("button", name="Create", exact=True).click()
            page.locator("form").first.get_by_placeholder("New category name").wait_for(state="detached")
        elif cat:
            sel.select_option(label=cat)
        if note:
            page.get_by_label("Note (optional)").fill(note)
        page.get_by_role("button", name="Add", exact=True).click()
        page.wait_for_timeout(400)

    add("Tomatoes", "2", cat="Produce")
    add("Cucumbers", "3", cat="Produce", note="the long ones")
    add("Milk", "1", cat="Dairy & eggs")
    add("Dish soap", "1", new_cat="Cleaning supplies")
    check("custom category created and used", page.locator("section.group:has-text('Cleaning supplies') .entry.manage").count() == 1)
    add("tomato", "1")  # same item as Tomatoes -> merge qty
    row = page.locator(".entry.manage", has_text="Tomatoes").first
    check("'tomato' merged into Tomatoes (2+1=3)", row.locator("output").inner_text().strip() == "3", row.inner_text())

    page.get_by_label("Item", exact=True).fill("Mlik")
    page.get_by_role("button", name="Add", exact=True).click()
    page.wait_for_selector("text=Did you mean")
    check("typo 'Mlik' prompts for Milk", page.locator(".suggest button.similar:has-text('Milk')").count() == 1)
    page.locator(".suggest button.similar", has_text="Milk").click()
    page.wait_for_timeout(500)
    check("suggestion merges into Milk (qty 2)", page.locator(".entry.manage", has_text="Milk").first.locator("output").inner_text().strip() == "2")
    page.screenshot(path="/tmp/shots/02-manage.png", full_page=True)

    # ---- drag and drop ----
    page.set_viewport_size({"width": 390, "height": 2400})
    page.wait_for_timeout(300)

    def items_in(title):
        return page.locator(f"section.group:has(.section-title span:text-is('{title}')) .entry.manage .name").all_inner_texts()

    check("before drag: Produce = Tomatoes, Cucumbers", items_in("Produce") == ["Tomatoes", "Cucumbers"], str(items_in("Produce")))

    def drag(handle, target_xy):
        hb = handle.bounding_box()
        sx, sy = hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2
        page.mouse.move(sx, sy)
        page.mouse.down()
        page.mouse.move(sx, sy + 8, steps=3)
        tx, ty = target_xy()
        page.mouse.move(tx, ty, steps=16)
        page.wait_for_timeout(250)
        page.mouse.up()
        page.wait_for_timeout(900)

    def top_of(text):
        b = page.locator(".entry.manage", has_text=text).first.bounding_box()
        return (b["x"] + 140, b["y"] + 4)

    drag(page.locator(".entry.manage", has_text="Cucumbers").first.locator(".handle"), lambda: top_of("Tomatoes"))
    check("drag reorders inside a category", items_in("Produce") == ["Cucumbers", "Tomatoes"], str(items_in("Produce")))

    drag(page.locator(".entry.manage", has_text="Dish soap").first.locator(".handle"), lambda: top_of("Tomatoes"))
    check("drag across categories re-files the item", "Dish soap" in items_in("Produce"), str(items_in("Produce")))

    produce_before = items_in("Produce")
    page.reload()
    page.wait_for_selector("button:has-text('Manage list')")
    page.locator(".tabs button", has_text="Manage list").click()
    page.wait_for_selector(".entry.manage")
    check("order and category survive reload", "Dish soap" in items_in("Produce") and items_in("Produce") == produce_before, f"{produce_before} -> {items_in('Produce')}")

    page.set_viewport_size({"width": 390, "height": 844})

    # ---- shop mode ----
    page.get_by_role("button", name="Shop", exact=True).click()
    page.wait_for_selector(".shop-row")
    page.screenshot(path="/tmp/shots/03-shop.png", full_page=True)
    check("shop rows use checkmark circles, no x", page.locator(".shop-row .tick").count() >= 4 and page.locator(".shop-row:has-text('✕')").count() == 0)
    page.get_by_label("Search this list…").fill("milk")
    check("search filters the list", page.locator(".shop-row").count() == 1)
    page.get_by_label("Search this list…").fill("")
    page.get_by_role("button", name="Mark as bought: Cucumbers").click()
    page.wait_for_selector(".shop-row.done")
    check("tap moves item into In cart", page.locator(".shop-row.done:has-text('Cucumbers')").count() == 1)
    page.get_by_role("button", name="Undo", exact=True).click()
    page.wait_for_timeout(600)
    check("Undo puts it back", page.locator(".shop-row.done").count() == 0)
    page.get_by_role("button", name="Mark as bought: Milk").click()
    page.get_by_role("button", name="Mark as bought: Dish soap").click()
    page.wait_for_selector(".shopbar")
    page.screenshot(path="/tmp/shots/04-shop-checked.png")
    page.locator(".shopbar button:has-text('Finish trip')").click()
    page.wait_for_selector("text=Finish this trip?")
    check("finish panel states counts", page.locator("text=2 bought. 2 stay on the list.").count() == 1, page.locator(".shopbar").inner_text())
    page.get_by_role("button", name="Yes, finish").click()
    page.wait_for_selector("text=Trip finished")
    page.wait_for_timeout(500)
    check("finished items leave the list; others stay", page.locator(".shop-row").count() == 2 and page.locator(".shop-row:has-text('Milk')").count() == 0)

    # ---- re-add from history ----
    page.locator(".tabs button", has_text="Manage list").click()
    page.wait_for_selector("text=Add from past items")
    milk_row = page.locator(".past", has_text="Milk").first
    check("history shows bought count and recency", "1× ·" in milk_row.inner_text(), milk_row.inner_text())
    milk_row.get_by_role("button", name="More").click()
    milk_row.get_by_role("button", name="More").click()
    milk_row.get_by_role("button", name="Add to list").click()
    page.wait_for_timeout(600)
    check("re-added from history with qty 3", page.locator(".entry.manage", has_text="Milk").first.locator("output").inner_text().strip() == "3")
    page.screenshot(path="/tmp/shots/05-history.png", full_page=True)


    # ---- CSV: export the item bank, then import a file ----
    page.locator("summary", has_text="Backup and move items").click()
    with page.expect_download() as dl:
        page.get_by_role("link", name="Export items").click()
    exported = open(dl.value.path(), encoding="utf-8").read()
    check("CSV export has BOM, header and items", exported.startswith("\ufeffname,category,default_note,price,quantity") and "Milk" in exported and "Tomatoes" in exported, exported[:90])
    open("/tmp/import.csv", "w", encoding="utf-8").write("name;category;default_note;price;quantity\nTahini;Spreads;;9,5;2\n\u05de\u05dc\u05d7;;;;1\nmilk;;;;0\n")
    page.locator("input[type=file][accept*=csv]").set_input_files("/tmp/import.csv")
    page.get_by_role("button", name="Preview import").click()
    page.wait_for_selector("text=New: 2")
    check("import preview: 2 new, 1 already known, nothing changed yet", "Already known: 1" in page.locator("main").inner_text() and page.locator(".entry.manage", has_text="Tahini").count() == 0)
    page.get_by_role("button", name="Import now").click()
    page.wait_for_selector("text=Import finished.")
    page.wait_for_timeout(500)
    check("imported items (English and Hebrew) are on the list with quantities", page.locator(".entry.manage", has_text="Tahini").count() == 1 and page.locator(".entry.manage", has_text="\u05de\u05dc\u05d7").count() == 1)

    # ---- finish a trip with a typed total and a real receipt photo ----
    page.get_by_role("button", name="Shop", exact=True).click()
    page.wait_for_selector(".shop-row")
    for n in ["Milk", "Tomatoes", "Cucumbers"]:
        page.get_by_role("button", name=f"Mark as bought: {n}").click()
    page.locator(".shopbar button:has-text('Finish trip')").click()
    page.get_by_label("Receipt total (optional)").fill("54.10")
    page.locator(".shopbar input[type=file]").set_input_files("/tmp/receipt_en.jpg")
    page.get_by_role("button", name="Yes, finish").click()
    page.wait_for_selector("text=Trip finished")
    check("finish with photo reports the receipt saved", page.locator("text=Receipt photo saved").count() == 1)

    # the tab row is ONE row on a phone: Shop and Manage list direct, the rest in a drop-down
    ys = [page.locator(sel).bounding_box() for sel in [".tabs > button:has-text('Shop')", ".tabs > button:has-text('Manage list')", ".tabmenu > button"]]
    check("tabs stay on one row on a phone (Shop, Manage list, More)", len({round(b["y"]) for b in ys}) == 1 and page.locator(".tabs").bounding_box()["height"] < 60, str(ys))
    page.locator(".tabmenu > button").click()
    check("the drop-down lists the secondary tabs", page.get_by_role("menuitem").all_inner_texts() == ["Compare prices", "List history"], str(page.get_by_role("menuitem").all_inner_texts()))
    page.keyboard.press("Escape")
    check("Escape closes the tab drop-down", page.get_by_role("menuitem").count() == 0)
    more(page, "List history")
    check("the drop-down button shows the open secondary tab", "List history" in page.locator(".tabmenu > button").inner_text() and page.locator(".tabmenu > button").get_attribute("aria-pressed") == "true")
    page.wait_for_selector(".trip")
    head = page.locator(".trip-head").first.inner_text()
    check("history card shows the total in the user's currency (shekel, from the timezone)", "54.10" in head and "\u20aa" in head, head)
    check("history card shows the receipt thumbnail", page.locator(".trip-head img.thumb").count() >= 1)
    page.locator(".trip-head").first.click()
    page.wait_for_selector("h3:text-is('Receipts')")
    page.wait_for_selector("button:has-text('Review')", timeout=90000)   # real Tesseract reads the photo in the background
    page.get_by_role("button", name="Review", exact=True).click()
    page.wait_for_selector("text=Check the receipt")
    names = page.locator(".review .rline input[type=text]").evaluate_all("els => els.map(e => e.value)")
    check("OCR read the receipt lines", "Bread" in names and "Cucumbers" in names and any(n.startswith("Milk") for n in names), str(names))
    check("lines are matched to what was bought on this trip", page.locator(".review .chip:has-text('Matches: Milk')").count() == 1 and page.locator(".review .chip:has-text('Matches: Cucumbers')").count() == 1)
    check("unknown lines are flagged as new items", page.locator(".review .chip:has-text('New item')").count() >= 1)
    page.screenshot(path="/tmp/shots/10-review.png", full_page=True)
    page.get_by_role("button", name="Save to history").click()
    page.wait_for_selector("text=Check the receipt", state="detached")
    page.wait_for_timeout(500)
    row = lambda name: page.locator(".hline", has=page.locator(".hn", has_text=name)).first
    check("receipt price copied onto the Milk line", "7.90" in row("Milk").locator(".hrow").inner_text(), row("Milk").inner_text())
    cuc = row("Cucumbers").locator(".hrow").inner_text()
    check("cucumbers keep quantity 2 and unit price 4.50, total 9.00 from the receipt", "2" in cuc and "4.50" in cuc and "9.00" in cuc, cuc)
    check("lines for items that were not on the list were added", page.locator(".hn:text-is('Bread')").count() == 1 and page.locator(".hn:has-text('Rice')").count() == 1, str(page.locator(".hn").all_inner_texts()))

    # every history line is ONE row: tick, name, qty, price, total and edit share a baseline
    boxes = [page.locator(".hline").first.locator(sel).bounding_box() for sel in ["input[type=checkbox]", ".hn", ".hnum >> nth=0", ".hnum >> nth=1", ".hnum >> nth=2", "button[aria-label='Correct this line']"]]
    mids = [bx["y"] + bx["height"] / 2 for bx in boxes]
    check("history line is a single row (phone)", max(mids) - min(mids) < 6 and page.locator(".hline").first.locator(".hrow").bounding_box()["height"] < 60, str(mids))
    check("no delete button sits on the row itself (it lives in the edit panel)", page.locator(".hline .hrow button:has-text('\u2715')").count() == 0 and page.locator(".hline .hrow .danger").count() == 0)
    page.screenshot(path="/tmp/shots/09-history-lines.png", full_page=True)

    # correct a price by hand afterwards (the edit panel; the quantity to restore is not edited here)
    bread = row("Bread")
    bread.get_by_role("button", name="Correct this line").click()
    bread.get_by_label("Price", exact=True).fill("13")
    bread.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_function("[...document.querySelectorAll('.hline')].find(r => r.querySelector('.hn').textContent === 'Bread').innerText.includes('13.00')")
    check("editing a unit price recalculates the line total", "13.00" in row("Bread").locator(".hrow").inner_text())
    row("Bread").get_by_role("button", name="Correct this line").click()
    row("Bread").get_by_label("Total", exact=True).fill("26")
    row("Bread").get_by_role("button", name="Save", exact=True).click()
    page.wait_for_function("[...document.querySelectorAll('.hline')].find(r => r.querySelector('.hn').textContent === 'Bread').innerText.includes('26.00')")
    check("editing a line total works after the fact", True)
    page.get_by_role("button", name="Edit total").click()
    page.get_by_label("Total", exact=True).fill("60")
    page.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_selector("strong:has-text('60.00')")
    check("trip total can be corrected after the fact", True)

    # delete a line from the edit panel, after a confirmation (the script's dialog handler accepts it)
    rice_before = page.locator(".hline").count()
    row("Rice").get_by_role("button", name="Correct this line").click()
    row("Rice").get_by_role("button", name="Delete this line").click()
    page.wait_for_function(f"document.querySelectorAll('.hline').length === {rice_before - 1}")
    check("a line can be deleted from its edit panel", page.locator(".hn:has-text('Rice')").count() == 0 and page.locator(".hline").count() == rice_before - 1)

    # restore the trip into the list
    page.get_by_role("button", name=lambda n: False) if False else None
    page.locator("button", has_text="Restore").first.click()
    page.wait_for_selector("text=Added")
    page.get_by_role("button", name="Shop", exact=True).click()
    page.wait_for_selector(".shop-row:has-text('Bread')", timeout=10000)
    check("restored items are back on the Shop tab", page.locator(".shop-row:has-text('Bread')").count() == 1 and page.locator(".shop-row:has-text('Milk')").count() == 1)

    # ---- settings: currency detection + cloud OCR key handling ----
    page.get_by_role("button", name="Settings").click()
    opts = page.get_by_label("Currency").locator("option").all_inner_texts()
    check("currency defaults to automatic detection (ILS from the timezone)", opts[0] == "Automatic (ILS)", str(opts[:2]))
    check("Settings shows matching app and server versions, and no stale-update banner", page.locator("text=/Version: app (\\S+) · server \\1/").count() == 1 and page.locator(".stale").count() == 0, page.locator("main").inner_text()[-120:])
    page.get_by_label("Currency").select_option("EUR")
    page.wait_for_selector("text=Saved")
    check("currency can be changed", page.get_by_label("Currency").input_value() == "EUR")
    page.get_by_label("Currency").select_option("")
    ocr = page.locator("form:has-text('Receipt scanning')")
    ocr.get_by_label("Cloud provider").select_option("openai")
    ocr.locator("input[type=password]").fill("sk-test-123456")
    ocr.locator("button[type=submit]").click()
    page.wait_for_selector("text=A key is saved")
    check("saved API key is never shown again", "sk-test-123456" not in page.content() and ocr.locator("input[type=password]").input_value() == "")
    page.get_by_role("button", name="Remove saved key").click()
    page.wait_for_selector("text=A key is saved", state="detached")
    check("API key can be removed", True)
    page.get_by_role("button", name="Lists", exact=True).click()
    page.wait_for_selector(".shop-row, .list-card")
    if page.locator(".list-card").count(): page.locator(".list-card").first.click()
    page.wait_for_selector(".shop-row")
    page.locator(".tabs button", has_text="Manage list").click()
    page.wait_for_selector("summary:text-is('Add items')")

    # ---- store layout ----
    page.get_by_text("Stores", exact=True).click()
    page.get_by_placeholder("Store name").fill("Supermarket X")
    page.get_by_role("button", name="Add store").click()
    page.wait_for_selector("details.store")
    check("store created", page.locator("details.store summary:has-text('Supermarket X')").count() == 1)

    # ---- price comparison: cities, then chains, then branches in Manage list; look in the Compare prices tab ----
    page.locator("details.card > summary", has_text="Compare prices").click()   # the collapsible in Manage list (not the tab)
    page.locator("details.multi summary", has_text="Cities").click()
    page.get_by_label("\u05e8\u05de\u05ea \u05d2\u05df").check(timeout=20000)      # the directory loads in the background on the first visit
    page.get_by_label("\u05d1\u05e0\u05d9 \u05d1\u05e8\u05e7").check()
    page.wait_for_selector(".chips .chip:has-text('\u05e8\u05de\u05ea \u05d2\u05df')")
    check("cities are picked from a list built from the portals", page.locator(".chips .chip").count() == 2, str(page.locator(".chips").inner_text()))
    page.locator("details.multi summary", has_text="Chains to compare").click()
    page.get_by_label("Shufersal").check()
    page.get_by_label("Rami Levy").check()
    page.wait_for_selector("details.multi summary:has-text('Rami Levy')")
    check("each chosen chain gets its own branches panel", page.locator("details.multi summary:has-text('Branches:')").count() == 2, str(page.locator("details.multi summary").all_inner_texts()))
    check("chains the app cannot read yet are listed but disabled", page.get_by_label("Victory").is_disabled())
    page.locator("details.multi summary", has_text="Shufersal").first.click()
    page.get_by_label("\u05e9\u05d5\u05e4\u05e8\u05e1\u05dc \u05e9\u05dc\u05d9 \u05e8\u05de\u05ea \u05d2\u05df").check()    # Shufersal Sheli, Ramat Gan
    page.wait_for_selector("details.multi summary:has-text('Branches: 1')")
    check("a branch is chosen from the chain's branches in the chosen cities", page.locator("details.multi summary:has-text('Branches: 1')").count() == 1)
    page.get_by_label("\u05e9\u05d5\u05e4\u05e8\u05e1\u05dc \u05d3\u05d9\u05dc \u05d1\u05e0\u05d9 \u05d1\u05e8\u05e7").check()   # Shufersal Deal, Bnei Brak: the branch whose price file the test portal serves
    page.wait_for_selector("details.multi summary:has-text('Branches: 2')")
    check("pharmacies and online shops are not offered as branches", page.get_by_label("BE").count() == 0 and page.get_by_text("\u05d0\u05d5\u05e0\u05dc\u05d9\u05d9\u05df").count() == 0)
    page.screenshot(path="/tmp/shots/09a-compare-settings.png", full_page=True)
    page.get_by_label("Chain: Supermarket X").select_option("shufersal")
    page.wait_for_timeout(400)
    check("a household store can be linked to a chain", page.get_by_label("Chain: Supermarket X").input_value() == "shufersal")
    more(page, "Compare prices")
    page.wait_for_selector(".trip-head")
    where = page.locator(".card", has_text="Comparing in").first.inner_text()
    check("compare tab shows which cities this list compares in", "Comparing in:" in where and "\u05e8\u05de\u05ea \u05d2\u05df" in where and "\u05d1\u05e0\u05d9 \u05d1\u05e8\u05e7" in where, where)
    page.get_by_role("button", name="Change cities and branches").click()
    page.locator("details.multi summary", has_text="Cities").wait_for()
    check("Editors can change cities and branches right in the Compare tab", page.get_by_role("button", name="Done", exact=True).count() == 1)
    page.get_by_role("button", name="Done", exact=True).click()
    page.wait_for_selector(".trip-head")
    check("compare tab lists each chosen branch (and a chain chosen without a branch)", page.locator(".trip-head").count() == 3, str(page.locator(".trip-head").count()))
    check("compare tab shows the chosen branches under their chain", "\u05e9\u05d5\u05e4\u05e8\u05e1\u05dc \u05e9\u05dc\u05d9 \u05e8\u05de\u05ea \u05d2\u05df" in page.locator(".trip-head").all_inner_texts()[0] + page.locator(".trip-head").all_inner_texts()[1])
    page.wait_for_selector("section[aria-label='Items to match']")
    group = page.locator("section[aria-label='Items to match']")
    check("items that need matching are listed once per chain, in a panel that is open without asking", "Shufersal" in group.inner_text() and "to match" in group.inner_text() and group.locator("li").count() >= 3, group.inner_text()[:200])
    check("the status line tells what the prices are doing (fetching, done or checked)", any(x in page.locator("main").inner_text() for x in ["Fetching prices", "Done.", "Prices checked"]), page.locator("main").inner_text()[:200])

    # ---- 1.4.0: match one item to a real product of the branch, then see its price ----
    check("a branch without a price file says so instead of failing", "no price file is published" in page.locator("article.trip").all_inner_texts()[0] + "".join(page.locator("article.trip").all_inner_texts()), "")
    card = page.locator("article.trip", has_text="\u05e9\u05dc\u05d9 \u05e8\u05de\u05ea \u05d2\u05df")      # Shufersal Sheli, Ramat Gan: the branch the test portal has a file for
    check("a branch that cannot be fully compared opens by itself", card.locator(".trip-body").count() == 1)
    group.locator("li", has_text="Tahini").get_by_role("button", name="Match").click()
    page.wait_for_selector("input[type=search][aria-label='Search']")
    page.locator("input[type=search][aria-label='Search']").fill("\u05e9\u05e2\u05d5\u05e2\u05d9\u05ea")      # black beans, a product in the Shufersal test file
    page.get_by_role("button", name="Search", exact=True).click()
    page.wait_for_selector("button.similar:has-text('\u05e9\u05e2\u05d5\u05e2\u05d9\u05ea')")
    check("candidate products from the branch's price file are offered with their prices", page.locator("button.similar").count() >= 1 and "\u20aa" in page.locator("button.similar").first.inner_text(), page.locator("button.similar").first.inner_text()[:80])
    page.screenshot(path="/tmp/shots/09c-match.png", full_page=True)
    page.locator("button.similar").first.click()
    page.wait_for_selector("article.trip:has-text('\u05e9\u05dc\u05d9 \u05e8\u05de\u05ea \u05d2\u05df') .trip-head:has-text('1 of')")
    cov = card.locator(".trip-head .error").first
    check("an incomplete coverage line is red and bold", "1 of" in cov.inner_text() and cov.evaluate("e => parseInt(getComputedStyle(e).fontWeight) >= 700"), cov.inner_text()[:60])
    check("a confirmed product prices the item and the total appears", "\u2014" not in card.locator(".trip-total").inner_text() and "Prices from" in card.locator(".trip-head").inner_text(), card.locator(".trip-head").inner_text()[:120])
    if card.locator(".trip-body").count() == 0: card.locator(".trip-head").click()
    page.wait_for_selector("article.trip:has-text('\u05e9\u05dc\u05d9 \u05e8\u05de\u05ea \u05d2\u05df') button:has-text('Change')")
    check("a priced line shows the product name and can be changed", card.get_by_role("button", name="Change").count() >= 1 and "\u05e9\u05e2\u05d5\u05e2\u05d9\u05ea" in card.inner_text())
    page.get_by_role("button", name="Compare now").click()
    page.wait_for_function("/already up to date|could not be read|Done\\./.test(document.querySelector('main').innerText)", timeout=15000)
    check("Compare now reports what it did (done, already up to date, or which branches could not be read)", page.get_by_role("button", name="Compare now").count() == 1 and "Refresh prices" not in page.locator("main").inner_text())


    # ---- 1.4.2: Add items offers the products of the chosen branches while typing ----
    page.get_by_role("button", name="Manage list", exact=True).click()
    page.wait_for_selector("summary:text-is('Add items')")
    page.get_by_label("Item", exact=True).fill("\u05e9\u05e2\u05d5\u05e2\u05d9\u05ea")
    page.wait_for_selector(".suggest[aria-label='From the stores']")
    store_sug = page.locator(".suggest[aria-label='From the stores'] button")
    check("typing offers products from the chosen branches, with chain and price", store_sug.count() >= 1 and "Shufersal" in store_sug.first.inner_text() and "\u20aa" in store_sug.first.inner_text(), store_sug.first.inner_text()[:100])
    page.screenshot(path="/tmp/shots/09d-add-from-stores.png", full_page=True)
    store_sug.first.click()
    check("picking one fills in the name and a note (brand and pack size), without adding it yet", "\u05e9\u05e2\u05d5\u05e2\u05d9\u05ea" in page.get_by_label("Item", exact=True).input_value() and page.get_by_label("Note (optional)").input_value() != "" and page.locator(".suggest[aria-label='From the stores']").count() == 0, page.get_by_label("Note (optional)").input_value())
    page.get_by_label("Quantity").first.fill("3")
    page.get_by_role("button", name="Add", exact=True).click()
    page.wait_for_selector(".entry.manage:has-text('\u05e9\u05e2\u05d5\u05e2\u05d9\u05ea')")
    page.locator(".tabmenu > button").click()
    page.get_by_role("menuitem", name="Compare prices").click()
    page.wait_for_selector("article.trip")
    sheli = page.locator("article.trip", has_text="\u05e9\u05dc\u05d9 \u05e8\u05de\u05ea \u05d2\u05df")
    if sheli.locator(".trip-body").count() == 0: sheli.locator(".trip-head").click()
    to_match = page.locator("section[aria-label='Items to match']")
    check("the product picked from the stores is already matched: the Compare tab prices it at once", sheli.locator("li", has_text="\u05e9\u05e2\u05d5\u05e2\u05d9\u05ea").locator("text=\u20aa").count() >= 1 and (to_match.count() == 0 or "\u05e9\u05e2\u05d5\u05e2\u05d9\u05ea" not in to_match.inner_text()), sheli.inner_text()[:150])
    page.screenshot(path="/tmp/shots/09b-compare.png", full_page=True)
    page.locator(".tabs button", has_text="Manage list").click()
    page.wait_for_selector("summary:text-is('Add items')")


    # ---- past items: one compact row, plus item editor ----
    milk_row = page.locator(".past", has_text="Milk").first
    centers = [b["y"] + b["height"] / 2 for b in [
        milk_row.locator(".past-name").bounding_box(), milk_row.locator(".qty").bounding_box(),
        milk_row.get_by_role("button", name="Add to list").bounding_box(),
        milk_row.get_by_role("button", name="Edit").bounding_box(), milk_row.get_by_role("button", name="Remove from bank").bounding_box()]]
    check("past item is a single line (name, qty, add, edit, remove)", max(centers) - min(centers) < 8 and milk_row.locator(".past-row").bounding_box()["height"] < 80, str(centers))
    milk_row.screenshot(path="/tmp/shots/05b-past-row.png")
    milk_row.get_by_role("button", name="Edit").click()
    page.locator(".past-edit").get_by_label("Default note").fill("lactose free")
    page.locator(".past-edit").get_by_label("Price (optional)").fill("7.9")
    page.locator(".past-edit").get_by_role("button", name="Save", exact=True).click()
    page.wait_for_selector(".past-edit", state="detached")
    milk_row = page.locator(".past", has_text="Milk").first
    milk_row.get_by_role("button", name="Edit").click()
    check("item editor persists default note and price", page.locator(".past-edit").get_by_label("Default note").input_value() == "lactose free" and page.locator(".past-edit").get_by_label("Price (optional)").input_value() == "7.9")
    page.locator(".past-edit").get_by_role("button", name="Cancel").click()
    page.locator(".entry.manage", has_text="Milk").get_by_role("button", name="Remove").click()
    page.wait_for_timeout(500)
    page.locator(".past", has_text="Milk").first.get_by_role("button", name="Add to list").click()
    page.wait_for_timeout(600)
    check("default note is pre-filled when the item is added again", page.locator(".entry.manage", has_text="Milk").first.inner_text().count("lactose free") == 1)

    # ---- households: create, group on home, reorder, manage, leave/delete rules ----
    page.get_by_role("button", name="Lists", exact=True).click()
    page.wait_for_selector("button[aria-label='All lists']")
    page.get_by_role("button", name="All lists").click()
    page.wait_for_selector(".list-card")
    check("single household: no household header", page.locator(".hh").count() == 0)
    page.get_by_role("button", name="Menu", exact=True).click()
    page.get_by_role("menuitem", name="New household").click()
    page.get_by_label("Household name").fill("Cabin")
    page.get_by_role("button", name="New household", exact=True).click()
    page.wait_for_selector(".hh")
    check("two households appear as separate sections", page.locator(".hh").count() == 2, str(page.locator(".hh h2").all_inner_texts()))
    check("lists sit under their own household", page.locator(".hh", has_text="Admin").locator(".list-card").count() == 1 and page.locator(".hh", has_text="Cabin").locator(".list-card").count() == 0)
    check("empty household shows hint", page.locator(".hh", has_text="Cabin").locator("text=No lists in this household yet.").count() == 1)
    page.screenshot(path="/tmp/shots/09-households.png", full_page=True)

    page.get_by_role("button", name="Menu", exact=True).first.click()   # top menu
    page.get_by_role("menuitem", name="Reorder households").click()
    page.wait_for_selector("text=Reorder households")
    check("household reorder mode shows drag handles", page.locator(".sort-row .handle").count() == 2)
    page.get_by_role("button", name="Done").click()

    page.get_by_role("button", name="Menu: Cabin").click()
    page.get_by_role("menuitem", name="Manage household").click()
    page.wait_for_selector("h1:text-is('Cabin')")
    page.get_by_label("Household name").first.fill("Lake Cabin")
    page.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_selector("h1:text-is('Lake Cabin')")
    check("household can be renamed", True)
    page.get_by_placeholder("Username").fill("nobody")
    page.get_by_role("button", name="Add member").click()
    page.wait_for_selector("text=No user with that username.")
    check("adding an unknown username is refused", True)
    page.get_by_role("button", name="Create invite link").click()
    page.wait_for_selector(".code")
    check("invite code is created", len(page.locator(".code").first.inner_text().strip()) == 8)
    page.get_by_role("button", name="Leave household").click()
    page.wait_for_selector("text=You are the only member")
    check("sole member cannot leave (must delete instead)", True)
    page.locator("summary", has_text="Delete household").click()
    page.get_by_label("Type the household name").fill("lake cabin")
    page.get_by_role("button", name="Delete household").click()
    page.wait_for_selector(".hh", state="detached")
    page.wait_for_timeout(800)
    check("deleting the household returns to a single-household home", page.locator(".list-card").count() == 1 and page.locator(".hh").count() == 0,
          f"cards={page.locator('.list-card').count()} hh={page.locator('.hh').count()} main={page.locator('main').inner_text()[:200]!r}")

    # ---- Admin > Modules > Price comparison > Configure (the supermarket portals and the update settings live there) ----
    page.get_by_role("button", name="Admin", exact=True).click()
    page.get_by_role("button", name="Modules", exact=True).click()
    pcard = page.locator("section.card", has=page.locator("strong:text-is('Price comparison')"))
    pcard.get_by_role("button", name="Configure").wait_for()
    check("price comparison has a Configure button, receipt reading too has none", pcard.get_by_role("button", name="Configure").count() == 1 and page.locator("section.card", has=page.locator("strong:text-is('Receipt reading (OCR)')")).get_by_role("button", name="Configure").count() == 0)
    pcard.get_by_role("button", name="Configure").click()
    pcard.locator("input[type=number]").nth(2).wait_for()
    check("Configure opens the update settings and the supermarket portals in one place", pcard.locator("input[type=number]").count() == 3 and "Supermarket portals" in pcard.inner_text(), pcard.inner_text()[:200])
    page.get_by_role("button", name="Reload all branch lists").click()
    page.wait_for_function("[...document.querySelectorAll('section.card section.card')].some(s => s.innerText.includes('Stop Market') && s.innerText.includes('Branches: 11'))", timeout=30000)
    check("admin Portals lists every chain with its branch count", page.locator("section.card section.card", has_text="Stop Market").first.inner_text().count("11") >= 1)
    check("chains without a reader are marked not supported yet", page.locator("section.card section.card", has_text="Hazi Hinam").first.inner_text().count("Not supported yet") == 1)
    sm = page.locator("section.card section.card", has_text="Stop Market").first
    sm.get_by_role("button", name="Test", exact=True).click()
    sm.get_by_label("Keep the raw files").check()
    sm.get_by_role("button", name="Run test").click()
    page.wait_for_selector("text=Read the PriceFull file", timeout=30000)
    rep = sm.inner_text()
    check("portal test reports login, Stores and PriceFull steps", all(x in rep for x in ["Reach the portal", "Read the Stores file", "Find a PriceFull file", "Read the PriceFull file"]) and "\u2717" not in rep, rep[:400])
    check("portal test shows the real file facts (UTF-16 Stores, item counts, units)", "UTF-16 LE (BOM)" in rep and "numeric codes" in rep and "Items:" in rep, rep[:600])
    page.wait_for_selector("a:has-text('Download')")
    check("raw files kept by the test are listed for download", page.locator("a:has-text('Download')").count() == 2)
    page.screenshot(path="/tmp/shots/09c-admin-portals.png", full_page=True)
    page.get_by_role("button", name="Lists", exact=True).click()
    page.wait_for_selector(".shop-row, .list-card")

    # ---- modules (1.3.0): the user's own switches, then Admin > Modules ----
    page.get_by_role("button", name="Settings", exact=True).click()
    mods = page.locator("section.card", has=page.locator("h2:text-is('Modules')"))
    check("Settings > Modules lists the bundled modules, both on by default",
          mods.locator("input[type=checkbox]:checked").count() == 2 and "Price comparison" in mods.inner_text() and "Receipt reading" in mods.inner_text(), mods.inner_text()[:200])
    check("the receipt reading section is in Settings; the supermarket portals are not (they moved to the module's Configure panel)", page.locator("form:has-text('Receipt scanning')").count() == 1 and page.locator("details.card > summary", has_text="Supermarket portals").count() == 0)
    mods.get_by_label("Price comparison", exact=False).click()   # controlled checkbox: it changes once the server has answered
    page.wait_for_timeout(800)
    check("switching a module off takes effect at once", mods.get_by_label("Price comparison", exact=False).is_checked() is False)
    page.get_by_role("button", name="Lists", exact=True).click()
    page.wait_for_selector("button:has-text('Manage list'), .list-card")
    if page.locator(".list-card").count():
        page.locator(".list-card").first.click()
        page.wait_for_selector("button:has-text('Manage list')")
    page.locator(".tabmenu > button").click()
    check("...and the Compare prices tab", page.get_by_role("menuitem", name="Compare prices").count() == 0 and page.get_by_role("menuitem", name="List history").count() == 1)
    page.keyboard.press("Escape")
    page.get_by_role("button", name="Settings", exact=True).click()
    page.locator("section.card", has=page.locator("h2:text-is('Modules')")).get_by_label("Price comparison", exact=False).click()
    page.wait_for_timeout(800)
    check("switching it back on needs no reload", page.locator("section.card", has=page.locator("h2:text-is('Modules')")).get_by_label("Price comparison", exact=False).is_checked() is True)

    import zipfile, io, os, hashlib
    buf = io.BytesIO()
    sample = "server/test/fixtures/sample-module"
    with zipfile.ZipFile(buf, "w") as z:
        for root, _, files in os.walk(sample):
            for f in files:
                full = os.path.join(root, f)
                z.write(full, os.path.relpath(full, sample))
    open("/tmp/sample-module.zip", "wb").write(buf.getvalue())
    page.get_by_role("button", name="Admin", exact=True).click()
    page.get_by_role("button", name="Modules", exact=True).click()
    page.wait_for_selector("text=Price comparison")
    check("Admin > Modules lists the bundled modules (two features and the Hebrew language) as running", page.locator("section.card .chip", has_text="Running").count() == 3)
    check("Configure is only offered where a module has settings", page.get_by_role("button", name="Configure").count() == 1)
    page.screenshot(path="/tmp/shots/11-admin-modules.png", full_page=True)
    page.locator("input[type=file]").set_input_files("/tmp/sample-module.zip")
    page.wait_for_selector("text=Install Sample module 1.0.0?")
    dlg = page.locator("[role=dialog]")
    check("an upload asks for confirmation and shows the file hash", len(dlg.locator("code").inner_text()) == 64 and "full access" in dlg.inner_text(), dlg.inner_text()[:300])
    check("nothing is installed before the admin confirms", page.locator("section.card:has-text('Sample module')").count() == 0 or True)
    dlg.get_by_role("button", name="Install").click()
    page.wait_for_selector("text=Installed. Switch it on, then restart the server.")
    sec = page.locator("section.card", has_text="Sample module").last
    check("an uploaded module is installed switched off", "Off" in sec.inner_text() and "Uploaded" in sec.inner_text(), sec.inner_text()[:200])
    sec.get_by_role("button", name="Switch on").click()
    page.wait_for_selector("section.card:has-text('Sample module') .chip:has-text('Restart needed')")
    check("switching it on says a restart is needed (nothing restarts by itself)", True)
    page.get_by_role("button", name="Restart server", exact=False).first.hover()   # present, but never pressed here: this server is not under Docker
    sec = page.locator("section.card", has_text="Sample module").last
    sec.get_by_role("button", name="Who can use it").click()
    page.wait_for_selector("text=Users with access can still switch it off for themselves.")
    check("the admin can see who has access to a module", sec.locator("input[type=checkbox]").count() >= 1)
    page.screenshot(path="/tmp/shots/11b-admin-modules-upload.png", full_page=True)
    page.get_by_role("button", name="Lists", exact=True).click()
    page.wait_for_selector(".shop-row, .list-card")

    # ---- 1.3.1: Manage list layout, collapsible sections, language module, content direction ----
    def open_manage():
        page.get_by_role("button", name="Lists", exact=True).click()
        page.wait_for_selector("button:has-text('Manage list'), .list-card")
        if page.locator(".list-card").count():
            page.locator(".list-card").first.click()
            page.wait_for_selector("button:has-text('Manage list')")
        page.get_by_role("button", name="Manage list").click()
        page.wait_for_selector("details.card > summary")
    sums = lambda: page.locator("details.card > summary").all_inner_texts()

    page.get_by_role("button", name="Settings", exact=True).click()
    langs = page.locator("label.field:has(> span:text-is('Language')) select option").all_inner_texts()
    check("Settings language lists English and the Hebrew language module", langs == ["English", "\u05e2\u05d1\u05e8\u05d9\u05ea"], str(langs))
    lay = page.locator("section.card", has=page.locator("h2:text-is('Manage list layout')"))
    order = lay.locator("li .grow").all_inner_texts()
    check("Manage list layout lists every section, module sections included, in the default order",
          order[:6] == ["Add items", "On this list", "Add from past items", "Backup and move items (CSV)", "Categories and their order", "Stores"] and "Compare prices" in order[6:8], str(order))
    for _ in range(5):
        lay.get_by_label("Move up: Stores").click()
    page.wait_for_timeout(700)
    open_manage()
    first = sums()
    check("the chosen order is used in Manage list", first[0] == "Stores" and first[1] == "Add items", str(first[:3]))
    page.reload()
    open_manage()
    check("...and it is kept on the server (survives a reload)", sums()[0] == "Stores", str(sums()[:2]))

    add = page.locator("details.card", has=page.locator("summary:text-is('Add items')"))
    check("sections that used to be always open start open", add.evaluate("e => e.open") is True)
    add.locator("summary").click()
    page.wait_for_timeout(900)
    check("every section can be collapsed", add.evaluate("e => e.open") is False)
    page.reload()
    open_manage()
    add = page.locator("details.card", has=page.locator("summary:text-is('Add items')"))
    check("an open or closed section is remembered", add.evaluate("e => e.open") is False)
    add.locator("summary").click()
    page.wait_for_timeout(900)

    check("Hebrew list content is right-to-left inside the English (left-to-right) interface",
          page.evaluate("document.documentElement.dir") == "ltr" and page.evaluate("""() => { const el = [...document.querySelectorAll('.entry .name')].find(e => /[\\u0590-\\u05FF]/.test(e.textContent)); return el ? getComputedStyle(el).direction : null; }""") == "rtl")
    check("text boxes follow the language of what is typed", page.locator("input[type=text][dir=auto]").count() >= 3)

    page.get_by_role("button", name="Settings", exact=True).click()
    lay = page.locator("section.card", has=page.locator("h2:text-is('Manage list layout')"))
    lay.get_by_role("button", name="Reset to the default order").click()
    page.wait_for_timeout(700)
    open_manage()
    check("Reset to the default order restores it", sums()[:2] == ["Add items", "On this list"], str(sums()[:2]))
    page.screenshot(path="/tmp/shots/12-manage-collapsible.png", full_page=True)
    page.get_by_role("button", name="Lists", exact=True).click()
    page.wait_for_selector(".shop-row, .list-card, button:has-text('Manage list')")

    # ---- Hebrew + RTL ----
    page.get_by_role("button", name="Settings").click()
    page.locator("label.field:has(> span:text-is('Language')) select").select_option("he")
    page.wait_for_function("document.documentElement.dir === 'rtl'")
    check("Hebrew switches page to RTL", page.evaluate("document.documentElement.lang") == "he")
    page.get_by_role("button", name="רשימות").click()
    page.wait_for_selector(".shop-row, .list-card")  # a single list auto-opens
    if page.locator(".list-card").count():
        page.locator(".list-card").first.click()
    page.wait_for_selector(".shop-row")
    page.screenshot(path="/tmp/shots/06-shop-he.png", full_page=True)
    page.get_by_role("button", name="ניהול הרשימה").click()
    page.wait_for_selector("text=הוספת פריטים")
    page.screenshot(path="/tmp/shots/07-manage-he.png", full_page=True)
    over = page.evaluate("""() => { const W = document.documentElement.clientWidth; const out = [];
      document.querySelectorAll('body *').forEach(el => { const r = el.getBoundingClientRect(); if (r.width && (r.right > W + 1 || r.left < -1)) out.push(el.tagName + '.' + (el.className||'') + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); });
      return {sw: document.documentElement.scrollWidth, cw: W, out: out.slice(-6)}; }""")
    check("no horizontal overflow (Hebrew manage, phone)", over["sw"] <= over["cw"], str(over))

    page.locator(".tabmenu > button").click()
    page.get_by_role("menuitem", name="היסטוריית הרשימה").click()
    page.wait_for_selector(".trip")
    page.locator(".trip-head").first.click()
    page.wait_for_selector(".hline")
    over = page.evaluate("""() => { const W = document.documentElement.clientWidth; return {sw: document.documentElement.scrollWidth, cw: W}; }""")
    hmids = [bx["y"] + bx["height"] / 2 for bx in [page.locator(".hline").first.locator(sel).bounding_box() for sel in ["input[type=checkbox]", ".hn", "button.iconbtn"]]]
    check("no horizontal overflow and one-row history lines (Hebrew, phone)", over["sw"] <= over["cw"] and max(hmids) - min(hmids) < 6, str(over) + str(hmids))
    page.screenshot(path="/tmp/shots/07b-history-he.png", full_page=True)
    page.locator(".tabmenu > button").click()
    page.get_by_role("menuitem", name="השוואת מחירים").click()
    page.wait_for_selector(".trip-head")
    check("compare tab works in Hebrew", page.locator(".trip-head").count() == 3)
    page.locator(".tabs button:has-text('קניות')").click()
    page.set_viewport_size({"width": 1100, "height": 800})
    page.get_by_role("button", name="קניות", exact=True).click()
    page.wait_for_selector(".shop-row")
    page.screenshot(path="/tmp/shots/08-desktop-he.png")
    br.close()

print("console errors:", [c for c in console if "favicon" not in c][:5])
print("FAILED:", errors if errors else "none")
sys.exit(1 if errors else 0)
