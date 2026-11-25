# Admin households test (1.8.1): the Households tab, a user's households, adding and removing members, roles, and deleting a household.
# Needs the app on 127.0.0.1:3994 with a FRESH data dir:
#   DATA_DIR=/tmp/admin-data WEB_DIR=web/dist PORT=3994 node server/src/index.js &
# Then:  python e2e/e2e_admin.py   (screenshots go to /tmp/shots)
from playwright.sync_api import sync_playwright
import sys

BASE = "http://127.0.0.1:3994"
H = {"X-SL-Client": "web", "Content-Type": "application/json"}
errors = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""), flush=True)
    if not cond:
        errors.append(name)


with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844}, locale="en-US", timezone_id="Asia/Jerusalem")
    api = lambda m, path, body=None: getattr(ctx.request, m)(BASE + "/api" + path, headers=H, data=body)
    admin_hid = api("post", "/setup", {"name": "Admin", "username": "admin", "password": "correct-horse"}).json()["user"]["households"][0]["id"]
    for u in ("dana", "avi", "noa"):
        api("post", "/admin/users", {"name": u.capitalize(), "username": u, "householdId": admin_hid})
    users = {u["username"]: u["id"] for u in api("get", "/admin/users").json()["users"]}
    cohen = api("post", "/admin/households", {"name": "Cohen family"}).json()["id"]          # the admin owns it at first, to put a list in it
    lid = api("post", "/lists", {"householdId": cohen, "name": "Groceries"}).json()["id"]
    api("post", f"/lists/{lid}/entries", {"name": "Milk", "quantity": 1})
    api("post", f"/households/{cohen}/members", {"username": "dana", "role": "owner"})
    api("post", f"/households/{cohen}/leave", {})                                                  # ... and Dana is the owner

    page = ctx.new_page()
    page.set_default_timeout(8000)
    page.on("dialog", lambda d: d.accept())
    console = []
    page.on("pageerror", lambda e: console.append(str(e)))
    no_overflow = lambda: page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    page.goto(BASE)
    page.get_by_role("button", name="Menu", exact=True).click()
    page.get_by_role("menuitem", name="Admin").click()

    # ---- the Households tab
    page.get_by_role("button", name="Households", exact=True).click()
    page.wait_for_selector("text=Cohen family")
    body = page.locator("main, body").first.inner_text()
    check("Households lists every household with members, lists and owners", "Cohen family" in body and "owners: Dana" in body and "1 members" in body, body[:300])
    check("no horizontal overflow (Households)", no_overflow())
    page.screenshot(path="/tmp/shots/40-admin-households.png")

    # ---- open one: add Avi as owner, Noa as member, change a role, the last-owner guard
    page.get_by_text("Cohen family").first.click()
    page.get_by_label("Add a user…").select_option(label="Avi (@avi)")
    page.get_by_label("Role", exact=True).select_option("owner")
    page.get_by_role("button", name="Add", exact=True).click()
    page.wait_for_selector("text=@avi")
    page.get_by_label("Add a user…").select_option(label="Noa (@noa)")
    page.get_by_role("button", name="Add", exact=True).click()
    page.wait_for_selector("text=@noa")
    members = {m["username"]: m["role"] for m in [h for h in api("get", "/admin/households").json()["households"] if h["id"] == cohen][0]["members"]}
    check("Add puts a user in the household with the chosen role", members == {"dana": "owner", "avi": "owner", "noa": "member"}, str(members))
    page.get_by_label("Noa: Role").select_option("owner")
    page.wait_for_function("document.querySelector(\"select[aria-label='Noa: Role']\").value === 'owner'")
    page.get_by_label("Remove from Noa").click()
    page.wait_for_function("!document.querySelector(\"[aria-label='Remove from Noa']\")")
    members = [m["username"] for m in [h for h in api("get", "/admin/households").json()["households"] if h["id"] == cohen][0]["members"]]
    check("a role can be changed and a member removed", sorted(members) == ["avi", "dana"], str(members))
    page.get_by_label("Remove from Avi").click()
    page.get_by_label("Remove from Dana").click()
    page.wait_for_selector("[role=alert]")
    check("the last owner cannot be removed (the screen says why)", "at least one owner" in page.locator("[role=alert]").inner_text(), page.locator("[role=alert]").inner_text())
    page.get_by_label("Household name").fill("Cohen household")
    page.get_by_role("button", name="Rename").click()
    page.wait_for_function("document.querySelector(\"input[aria-label='Household name']\").value === 'Cohen household'")
    check("a household can be renamed", [h["name"] for h in api("get", "/admin/households").json()["households"] if h["id"] == cohen] == ["Cohen household"])
    page.screenshot(path="/tmp/shots/41-admin-household-open.png", full_page=True)

    # ---- a user's own view: their households, add and remove from there
    page.get_by_role("button", name="← Households").click()
    page.get_by_role("button", name="Users", exact=True).click()
    card = page.locator("article.user-card", has_text="@noa")
    card.locator("summary").click()
    check("a user's card lists their households", "Households · 1" in card.inner_text(), card.inner_text()[:200])
    card.get_by_label("Noa: Add to a household…").select_option(label="Cohen household")
    card.get_by_role("button", name="Add", exact=True).click()
    card.locator("summary", has_text="Households · 2").wait_for()
    check("a user can be added to a household from their card", "Households · 2" in card.inner_text())
    card.get_by_label("Remove from Cohen household").click()
    card.locator("summary", has_text="Households · 1").wait_for()
    check("and removed from it", "Households · 1" in card.inner_text())
    page.screenshot(path="/tmp/shots/42-admin-user-households.png", full_page=True)

    # ---- delete: the warning shows the counts, the button waits for the typed name, everything goes
    page.get_by_role("button", name="Households", exact=True).click()
    page.get_by_text("Cohen household").first.click()
    page.get_by_role("button", name="Delete household…").click()
    warn = page.locator("[data-testid=hh-delete]").inner_text()
    check("the delete warning names what goes (lists, items, trips)", "1 lists and their 1 items" in warn and "trips" in warn, warn)
    btn = page.get_by_role("button", name="Delete everything")
    check("Delete everything waits for the typed name", btn.is_disabled())
    page.get_by_placeholder("Cohen household").fill("cohen household")
    check("and is enabled when the name matches", btn.is_enabled())
    page.screenshot(path="/tmp/shots/43-admin-delete.png", full_page=True)
    btn.click()
    page.wait_for_selector("text=Households ·", state="detached") if False else page.wait_for_function("!document.body.innerText.includes('Cohen household')")
    left = [h["name"] for h in api("get", "/admin/households").json()["households"]]
    check("the household is gone, with the other one still there", "Cohen household" not in left and len(left) == 1, str(left))
    check("its list is gone too", api("get", f"/lists/{lid}").status == 404)

    # ---- 1.9.0: new settings groups, automatic checkpoints, save/restore, file download and restore
    page.get_by_role("button", name="Server settings", exact=True).click()
    page.wait_for_selector("text=Abuse protection")
    body = page.locator("main, body").first.inner_text()
    check("Settings has the new groups (Limits, Abuse protection, Defaults, Server)", all(x in body for x in ("Limits", "Abuse protection", "Defaults", "Server (read-only)", "Largest receipt photo (MB)", "Allowed: 1–50")), body[:200])
    check("the server facts are shown read-only", "Data folder" in page.locator("[data-testid=server-info]").inner_text())
    check("no horizontal overflow (Settings)", no_overflow())
    page.get_by_label("Largest receipt photo (MB)").fill("20")
    page.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_selector("[role=status]")
    check("a limit is saved", api("get", "/admin/settings").json()["settings"]["max_image_mb"] == 20)
    page.get_by_label("Largest receipt photo (MB)").fill("99")
    check("the field knows its range (99 is invalid on the screen)", page.get_by_label("Largest receipt photo (MB)").evaluate("e => !e.checkValidity()"))
    page.get_by_role("button", name="Save", exact=True).click()
    check("and a value outside its range is not saved", api("get", "/admin/settings").json()["settings"]["max_image_mb"] == 20)
    page.get_by_label("Largest receipt photo (MB)").fill("20")

    page.get_by_role("button", name="Config", exact=True).click()
    page.wait_for_selector("[data-testid=cfg-checkpoint]")
    check("a checkpoint was saved automatically before the change", "Before: Largest receipt photo (MB)" in page.locator("[data-testid=cfg-checkpoint]").first.inner_text(), page.locator("[data-testid=cfg-checkpoint]").first.inner_text())
    page.get_by_role("button", name="Save checkpoint…").click()
    page.get_by_label("Name this checkpoint").fill("Working setup")
    page.get_by_role("button", name="Save", exact=True).click()
    page.locator("[data-testid=cfg-checkpoint]", has_text="Working setup").wait_for()
    check("a named checkpoint is saved", True)
    page.screenshot(path="/tmp/shots/44-admin-configuration.png", full_page=True)

    api("put", "/admin/settings", {"max_image_mb": 7, "rl_login_per_min": 30})
    page.reload(); page.get_by_role("button", name="Menu", exact=True).click(); page.get_by_role("menuitem", name="Admin").click()
    page.get_by_role("button", name="Config", exact=True).click()
    page.locator("[data-testid=cfg-checkpoint]", has_text="Working setup").get_by_role("button", name="Restore").click()
    pv = page.locator("[data-testid=cfg-preview]")
    pv.wait_for()
    check("the restore preview lists exactly what will change", "2 settings change" in pv.inner_text() and "7 → 20" in pv.inner_text() and "30 → 10" in pv.inner_text(), pv.inner_text())
    check("and nothing has changed yet", api("get", "/admin/settings").json()["settings"]["max_image_mb"] == 7)
    page.screenshot(path="/tmp/shots/45-admin-restore-preview.png", full_page=True)
    pv.get_by_role("button", name="Restore these settings").click()
    page.wait_for_selector("text=Restored")
    st = api("get", "/admin/settings").json()["settings"]
    check("restoring puts the settings back", st["max_image_mb"] == 20 and st["rl_login_per_min"] == 10, str(st["max_image_mb"]))
    check("and saves a restore point", page.locator("[data-testid=cfg-checkpoint]", has_text="restore point").count() >= 1)

    with page.expect_download() as dl:
        page.get_by_role("link", name="Download file").click()
    path = dl.value.path()
    import json as _json
    doc = _json.load(open(path))
    check("Download file gives the configuration as JSON, without the email password", doc["format"] == "shoplist-config" and "pass" not in doc["core"]["smtp"], str(list(doc)))
    api("put", "/admin/settings", {"max_image_mb": 33})
    page.get_by_role("button", name="Users", exact=True).click(); page.get_by_role("button", name="Config", exact=True).click()
    page.locator("input[type=file]").set_input_files(path)
    pv = page.locator("[data-testid=cfg-preview]"); pv.wait_for()
    check("Restore from file shows the same preview", "33 → 20" in pv.inner_text(), pv.inner_text())
    pv.get_by_role("button", name="Restore these settings").click(); page.wait_for_selector("text=Restored")
    check("and restores it", api("get", "/admin/settings").json()["settings"]["max_image_mb"] == 20)
    open("/tmp/not-a-config.json", "w").write('{"hello": 1}')
    page.locator("input[type=file]").set_input_files("/tmp/not-a-config.json")
    page.wait_for_selector("[role=alert]")
    check("a file that is not a configuration is refused with a message", "not a configuration file" in page.locator("[role=alert]").inner_text())
    n_before = page.locator("[data-testid=cfg-checkpoint]").count()
    page.locator("[data-testid=cfg-checkpoint]", has_text="Working setup").get_by_role("button", name="Delete").click()
    page.wait_for_function(f"document.querySelectorAll('[data-testid=cfg-checkpoint]').length === {n_before - 1}")
    check("a checkpoint can be deleted", True)
    check("no horizontal overflow (Configuration)", no_overflow())
    check("no page errors", not console, str(console))
    br.close()

print("FAILED:", errors or "none")
sys.exit(1 if errors else 0)
