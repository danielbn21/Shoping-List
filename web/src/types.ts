import type { Lang } from './i18n';

export type Household = { id: number; name: string; role: 'owner' | 'member' };
export type MeModule = { id: string; name: string; kind: string; version: string; description: string; on: boolean; slots: string[]; web: string | null; css: string | null; i18n: string | null; lang?: { code: string; nativeName: string; dir: 'ltr' | 'rtl'; locale: string }; strings?: string };
export type CatalogSuggestion = {
  name: string; note: string | null; categoryId: number | null; price: number | null; priceMax: number | null; currency: string | null; perKg: boolean;
  chains: { nameEn: string; nameHe: string }[]; ref: Record<string, unknown> | null;
};
export type Me = {
  id: number; username: string; email: string | null; name: string; role: 'admin' | 'user';
  language: Lang; theme: 'system' | 'light' | 'dark'; colorTheme: string; showAddedBy: boolean;
  mustChangePassword: boolean; households: Household[]; canCreateHousehold: boolean;
  currency: string | null;
  prefs: { manageOrder?: string[]; manageOpen?: Record<string, boolean> };   // interface preferences that follow the user
  modules: MeModule[];       // the modules this user may use (granted by the admin), each with the user's own on/off switch
  capabilities: string[];    // what those modules provide right now, e.g. 'receipt-reader'
};
export type Cfg = {
  needsSetup: boolean;
  registrationMode: 'open' | 'invite-only' | 'admin-only';
  emailResetAvailable: boolean;
  minPasswordLength: number;
  version?: string;
};

export type Cat = { id: number; nameEn: string; nameHe: string; sort: number };
export type ListSummary = { id: number; name: string; color: string; visibility: 'household' | 'private'; householdId: number; householdName: string; itemCount: number };
export const LIST_COLORS: Record<string, string> = {
  green: '#1d6b47', yellow: '#e8b800', blue: '#2a6fdb', red: '#c0392b', plum: '#7b3f8f', orange: '#e07b1a', gray: '#6b7a72',
};

export type Entry = {
  id: number; itemId: number; name: string; categoryId: number | null; quantity: number;
  unit: string | null; note: string | null; state: 'open' | 'in_cart'; position: number;
  addedByName: string | null; checkedAt: number | null; checkedByName: string | null;
};
export type Store = { id: number; name: string; categoryOrder: number[] };
export type Detail = {
  list: { id: number; name: string; color: string; visibility: string; householdId: number; role: 'owner' | 'contributor' | 'viewer' };
  entries: Entry[];
  categories: Cat[];
  stores: Store[];
  shoppingNow: { userId: number; name: string | null; since: number }[];
};
export type PastItem = {
  id: number; name: string; categoryId: number | null; onListQty: number; timesPurchased: number; lastPurchasedAt: number | null;
  defaultNote: string | null; price: number | null;
};

export type TripSummary = {
  id: number; finishedAt: number; total: number | null; computedTotal: number | null; currency: string | null; storeName: string | null;
  shopperName: string | null; itemCount: number; receiptCount: number; firstReceiptId: number | null;
};
export type TripLine = { id: number; itemId: number; name: string; quantity: number; unit: string | null; unitPrice: number | null; lineTotal: number | null };
export type ReceiptInfo = { id: number; ocrStatus: 'none' | 'pending' | 'done' | 'failed'; ocrEngine: string | null; ocrError: string | null; uploadedAt: number };
export type TripDetailData = {
  trip: { id: number; listId: number | null; listName: string | null; householdId: number; storeId: number | null; storeName: string | null; shopperName: string | null; finishedAt: number; total: number | null; currency: string | null };
  lines: TripLine[]; receipts: ReceiptInfo[]; stores: { id: number; name: string }[];
};

