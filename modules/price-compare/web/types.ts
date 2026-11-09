export type ChainInfo = { id: string; nameEn: string; nameHe: string; supported: boolean; enabled: boolean; custom: boolean };
export type SelEntry = { chain: string; branchId: string; branchName: string | null; cityKey: string; cityName: string; address: string; banner: string };
export type CompareResult = {
  chain: string; nameEn: string; nameHe: string; branches: { storeId: string; name: string | null; cityName: string }[];
  total: number | null; priced: number; of: number; missing: { itemId: number; name: string; quantity: number }[]; asOf: number | null; source: 'receipts';
};
export type CompareData = {
  canEdit: boolean; chains: ChainInfo[]; stores: { id: number; name: string; chain: string | null }[]; selection: SelEntry[]; cities: { key: string; name: string }[];
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
