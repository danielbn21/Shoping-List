export type ChainInfo = { id: string; nameEn: string; nameHe: string; supported: boolean; enabled: boolean; custom: boolean };
export type SelEntry = { chain: string; branchId: string; branchName: string | null; cityKey: string; cityName: string; address: string; banner: string };
export type Product = {
  code: string; itemType: number; name: string; manufacturer: string; price: number; unitPrice: number | null; unit: string; unitPer: number;
  weighted: boolean; pack: { amount: number; unit: string } | null; description?: string;
};
export type Line = {
  itemId: number; name: string; quantity: number; via: 'confirmed' | 'auto' | 'sameName' | 'barcode' | 'receipt'; autoFrom?: string; autoVia?: 'name' | 'barcode' | 'equivalent'; product: Product | null; amountKg: number | null;
  lineTotal: number; old: boolean; sizeDiffers?: boolean; paidAt?: number; unitPrice?: number;
};
// What the module thinks an item is at a chain when it is not sure enough to decide by itself: shown pre-filled, one tap to accept.
export type Guess = { tier: 'likely' | 'guess' | null; searched: string | null; product: { code: string; name: string; manufacturer: string | null; price: number | null; score: number | null } | null; alts: Product[] };
export type Missing = { itemId: number; name: string; quantity: number; guess?: Guess | null };
export type CompareResult = {
  chain: string; nameEn: string; nameHe: string; branchId: string; branchName: string | null; cityName: string; address: string; banner: string;
  total: number | null; priced: number; receiptCount: number; oldCount: number; of: number;
  lines: Line[]; needsMatch: Missing[]; notSold: (Missing & { reason: 'marked' | 'notAtBranch' })[];
  asOf: number | null; checkedAt: number | null; error: string | null; hasData: boolean;
};
export type PricesInfo = {
  running: boolean; done: number; total: number; current: { chain: string; storeId: string } | null; startedNow: boolean; refreshHours: number; oldAfterDays: number;
  lastJob: { finishedAt: number | null; updated: number; unchanged: number; failed: number } | null;
};
export type MatchGroup = { chain: string; nameEn: string; nameHe: string; items: Missing[] };
export type CompareData = {
  canEdit: boolean; chains: ChainInfo[]; stores: { id: number; name: string; chain: string | null }[]; selection: SelEntry[]; cities: { key: string; name: string }[];
  results: CompareResult[]; matchGroups: MatchGroup[]; openCount: number; prices: PricesInfo;
  guessing?: { pending: number; madeNow: number }; ai?: { enabled: boolean; pending: number; running: boolean; error: string | null };
};
export type Candidate = Product & { score: number; barcodeMatch: boolean };
export type MatchInfo = {
  item: { id: number; name: string }; chain: string; query: string; searchedAs?: string | null; noData: boolean; branches: number;
  current: { status: 'confirmed' | 'none' | 'auto'; code: string | null; name: string | null; amountKg: number | null; autoFrom: string | null } | null;
  viaBarcode: { code: string; name: string; from: string } | null; candidates: Candidate[];
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
