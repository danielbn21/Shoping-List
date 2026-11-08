import type { Lang } from './i18n';

export type Household = { id: number; name: string; role: 'owner' | 'member' };
export type Me = {
  id: number; username: string; email: string | null; name: string; role: 'admin' | 'user';
  language: Lang; theme: 'system' | 'light' | 'dark'; colorTheme: string; showAddedBy: boolean;
  mustChangePassword: boolean; households: Household[]; canCreateHousehold: boolean;
  currency: string | null; ocrEnabled: boolean; compareEnabled: boolean;
  ocr: { engine: 'auto' | 'local' | 'cloud'; provider: 'anthropic' | 'openai' | 'gemini'; model: string; hasKey: boolean };
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
export type Store = { id: number; name: string; chain: string | null; categoryOrder: number[] };
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

export type ChainInfo = { id: string; nameEn: string; nameHe: string; supported: boolean; enabled: boolean; custom: boolean };
export type SelEntry = { chain: string; branchId: string; branchName: string | null; cityKey: string; cityName: string; address: string; banner: string };
export type CompareResult = {
  chain: string; nameEn: string; nameHe: string; branches: { storeId: string; name: string | null; cityName: string }[];
  total: number | null; priced: number; of: number; missing: { itemId: number; name: string; quantity: number }[]; asOf: number | null; source: 'receipts';
};
export type CompareData = {
  enabled: boolean; canEdit: boolean; chains: ChainInfo[]; selection: SelEntry[]; cities: { key: string; name: string }[];
  results: CompareResult[]; openCount: number; source: 'receipts';
};
export type PortalCities = {
  loading: boolean; progress: { done: number; total: number } | null; cities: { key: string; name: string; branches: number; chains: number }[];
  chains: ChainInfo[]; stats: { chain: string; branches: number; fetchedAt: number | null; lastError: string | null }[];
};
export type PortalBranch = { chain: string; storeId: string; name: string; address: string; cityKey: string; cityName: string; banner: string; zip: string };

export type AdminChain = ChainInfo & {
  platform: string; user: string; chainId: string; branches: number; cities: number; zipFilled: number;
  fetchedAt: number | null; storesFile: string | null; lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null;
};
export type RefreshJob = { running: boolean; startedAt: number; finishedAt: number | null; done: number; total: number; current: string | null; results: { chain: string; ok: boolean; error?: string; branches?: number }[] } | null;
export type PortalStep = { name: 'open' | 'stores' | 'pricefull_list' | 'pricefull_parse'; ok: boolean; ms: number; detail?: Record<string, any> | null; error?: string; code?: string | null };
export type PortalReport = { chain: string; steps: PortalStep[]; files: { stores?: { name: string; size: number | null; time: string | null }[]; priceFull?: { name: string; size: number | null; time: string | null }[]; rawKeys?: string[] | null }; saved: string[] };
export type PortalSample = { chain: string; file: string; size: number };
