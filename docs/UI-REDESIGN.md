# UI redesign (1.9.2): decisions and stages

Agreed with the owner on 27 Nov 2026, built in 1.9.2 (stages 0 to 5 together). The code is the source of truth; this file keeps the reasons.

## Decisions

**Navigation**
1. Bottom tabs are for things you do: Shop, Manage, one module tab at most (Compare prices), History. Names stay Manage and History. No "More" dropdown: a module's second and later tabs open from the menu.
2. The ☰ menu is configuration, grouped by scope, with the same headings in the same order on every screen; a screen shows only the groups that apply:
   - **This list** (name and colour, people and access, list-level module sections),
   - **Household (all lists)** (stores, categories, items and CSV, members and invites, export purchases),
   - **Me** (Settings, Sign out),
   - **Server (admins only)** (Administration).
3. Delete list is at the bottom of "Name and colour", not in the menu, and needs the list name typed.
4. Every settings page names its scope in the header (`Household · Cohen`, `Me · Sam`).
5. Settings: Account, Preferences, Modules. One Sign out (the menu).
6. Administration: four areas (People = Users + Households, Modules, Server = Settings + Config, Activity log).

**Back button**
7. One shared header (`ScreenHeader`) on every screen below Home: arrow in the same place, always visible, never replaced; title; scope line (a breadcrumb from 1024 px); the menu on the other side. Home uses it without the arrow.
8. Routes live in the address (`web/src/nav.ts`, hash routes). The arrow, the system back gesture, the browser's Back and Esc all do the same thing; a refresh keeps the place. The arrow steps back through this app's own history, or goes to the parent screen when there is none (a link, or a refresh at the start).

**Roles and preferences**
9. Roles are unchanged: Owner, Editor, Shopper (no Manage; Shop and History only).
10. Preference "When I open a list": Where I left off (default), Always Shop, Always Manage. Stored on the server (`ui_prefs.openMode`, and `ui_prefs.last` = last list and the last tab of each list, newest 40). Opening the app goes to the last list when the setting is "Where I left off". A trip in progress (something ticked) always opens in Shop.
11. Quick add: a Shop search with no match offers "Add “x” to the list" (near-misses are asked the same way as in Manage). Hidden from Shoppers.

**Left as it was:** the Shop store selector (parked), Finish trip, tab names (Plan and Trips were declined for now), per-list override of the open-mode (not built).

## Device classes

| Class | Width | Layout |
|---|---|---|
| Small phone | up to 380 px | the phone layout; long names are cut with an ellipsis, the header keeps its height |
| Phone | to 640 px | bottom tab bar, ☰ as a bottom sheet, each page full screen |
| Tablet | 641 to 1023 px | tab pills at the top; ☰ popover; from 768 px Settings, Administration and list pages have a sidebar |
| Desktop | 1024 px and up | the same sidebar, breadcrumb in the header, Esc and hover; Manage side by side from 900 px |

The sidebar (`SideNav.tsx`) draws the same grouped list as the ☰ menu (`menus.ts`), so there is nothing new to learn.

## Where things are

`nav.ts` (routes, history), `ScreenHeader.tsx`, `SideNav.tsx`, `menus.ts`, `ListPages.tsx` (list pages in two groups), `Create.tsx` (new list, new household), `Settings.tsx`, `Admin.tsx`, `HouseholdScreen.tsx` (`HouseholdPage` parts + the screen), `prefs.ts` (open-mode and the remembered place).
Module slots are unchanged: `settings.section` is Me, `manage.section` is This list, `admin.section` is Server, `list.tab` is the one module tab (others join the menu).
