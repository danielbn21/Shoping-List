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
    check("no page errors", not console, str(console))
    br.close()

print("FAILED:", errors or "none")
sys.exit(1 if errors else 0)
