# Browser end-to-end test (needs: pip install playwright && python -m playwright install chromium).
# Start the app first:  DATA_DIR=/tmp/e2e-data WEB_DIR=web/dist PORT=3998 node server/src/index.js   (fresh data dir each run)
# Then:  python e2e/e2e.py   (screenshots go to /tmp/shots, which must exist)
from playwright.sync_api import sync_playwright
import sys

B = "http://127.0.0.1:3998"
errors = []


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
    check("shop tab has no add/edit controls", page.locator("h2:text-is('Add items')").count() == 0)

    # ---- manage: labeled fields ----
    page.get_by_role("button", name="Manage list").click()
    page.wait_for_selector("h2:text-is('Add items')")
    labels = [page.locator(f"label.field > span:text-is('{l}')").count() for l in ["Item", "Quantity", "Category", "Note (optional)"]]
    check("labels visible: Item/Quantity/Category/Note", all(c >= 1 for c in labels), str(labels))
    check("no Unit field in add form", page.get_by_label("Unit").count() == 0)

    def add(name, qty="1", cat=None, note=None, new_cat=None):
        page.get_by_label("Item", exact=True).fill(name)
        page.get_by_label("Quantity").first.fill(qty)
        sel = page.locator("form select").first
        if new_cat:
            sel.select_option("__new__")
            page.locator("form.card").first.get_by_placeholder("New category name").fill(new_cat)
            page.get_by_role("button", name="Create", exact=True).click()
            page.wait_for_selector("form.card >> nth=0 >> input[placeholder='New category name']", state="detached")
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
    page.get_by_role("button", name="Manage list").click()
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
    page.get_by_role("button", name="Manage list").click()
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

    page.get_by_role("button", name="List history").click()
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
    check("receipt price copied onto the Milk line", page.get_by_label("Total Milk").input_value() == "7.9", page.get_by_label("Total Milk").input_value())
    check("cucumbers keep quantity 2 and unit price 4.5 from the receipt", page.get_by_label("Qty Cucumbers").input_value() == "2" and page.get_by_label("Price Cucumbers").input_value() == "4.5")
    check("lines for items that were not on the list were added", page.locator(".hname:text-is('Bread')").count() == 1 and page.locator(".hname:has-text('Rice')").count() == 1, str(page.locator(".hname").all_inner_texts()))

    # correct a price by hand afterwards
    page.get_by_label("Price Bread").fill("13")
    page.get_by_label("Price Bread").press("Tab")
    page.wait_for_function("document.querySelector('[aria-label=\"Total Bread\"]').value === '13'")
    check("editing a unit price recalculates the line total", True)
    page.get_by_role("button", name="Edit total").click()
    page.get_by_label("Total", exact=True).fill("60")
    page.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_selector("strong:has-text('60.00')")
    check("trip total can be corrected after the fact", True)

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
    page.get_by_role("button", name="Manage list").click()
    page.wait_for_selector("h2:text-is('Add items')")

    # ---- store layout ----
    page.get_by_text("Stores", exact=True).click()
    page.get_by_placeholder("Store name").fill("Supermarket X")
    page.get_by_role("button", name="Add store").click()
    page.wait_for_selector("details.store")
    check("store created", page.locator("details.store summary:has-text('Supermarket X')").count() == 1)


    # ---- past items: one compact row, plus item editor ----
    milk_row = page.locator(".past", has_text="Milk").first
    centers = [b["y"] + b["height"] / 2 for b in [
        milk_row.locator(".past-name").bounding_box(), milk_row.locator(".qty").bounding_box(),
        milk_row.get_by_role("button", name="Add to list").bounding_box(),
        milk_row.get_by_role("button", name="Edit").bounding_box(), milk_row.get_by_role("button", name="Remove from bank").bounding_box()]]
    check("past item is a single line (name, qty, add, edit, remove)", max(centers) - min(centers) < 8 and milk_row.locator(".past-row").bounding_box()["height"] < 80, str(centers))
    page.screenshot(path="/tmp/shots/05b-past-row.png", clip=milk_row.bounding_box() | {"x": 0, "width": 390})
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

    page.set_viewport_size({"width": 1100, "height": 800})
    page.get_by_role("button", name="קניות", exact=True).click()
    page.wait_for_selector(".shop-row")
    page.screenshot(path="/tmp/shots/08-desktop-he.png")
    br.close()

print("console errors:", [c for c in console if "favicon" not in c][:5])
print("FAILED:", errors if errors else "none")
sys.exit(1 if errors else 0)
