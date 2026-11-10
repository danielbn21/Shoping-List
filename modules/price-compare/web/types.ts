export type ChainInfo = { id: string; nameEn: string; nameHe: string; supported: boolean; enabled: boolean; custom: boolean };
export type SelEntry = { chain: string; branchId: string; branchName: string | null; cityKey: string; cityName: string; address: string; banner: string };
export type Product = {
  code: string; itemType: number; name: string; manufacturer: string; price: number; unitPrice: number | null; unit: string; unitPer: number;
  weighted: boolean; pack: { amount: number; unit: string } | null;
};
export type Line = {
  itemId: number; name: string; quantity: number; via: 'confirmed' | 'barcode' | 'receipt'; product: Product | null; amountKg: number | null;
  lineTotal: number; old: boolean; sizeDiffers?: boolean; paidAt?: number; unitPrice?: number;
};
export type Missing = { itemId: number; name: string; quantity: number };
export type CompareResult = {
  chain: string; nameEn: string; nameHe: string; branchId: string; branchName: string | null; cityName: string; address: string; banner: string;
  total: number | null; priced: number; receiptCount: number; oldCount: number; of: number;
  lines: Line[]; needsMatch: Missing[]; notSold: (Missing & { reason: 'marked' | 'notAtBranch' })[];
  asOf: number | null; checkedAt: number | null; error: string | null; hasData: boolean;
};
export type PricesInfo = { running: boolean; done: number; total: number; current: { chain: string; storeId: string } | null; startedNow: boolean; refreshHours: number; oldAfterDays: number };
export type CompareData = {
  canEdit: boolean; chains: ChainInfo[]; stores: { id: number; name: string; chain: string | null }[]; selection: SelEntry[]; cities: { key: string; name: string }[];
  results: CompareResult[]; openCount: number; prices: PricesInfo;
};
export type Candidate = Product & { score: number; barcodeMatch: boolean };
export type MatchInfo = {
  item: { id: number; name: string }; chain: string; query: string; noData: boolean; branches: number;
  current: { status: 'confirmed' | 'none'; code: string | null; name: string | null; amountKg: number | null } | null;
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
