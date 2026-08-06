export type ManagedResourceStockStatus =
  | "missing"
  | "stock_current"
  | "stock_update_available"
  | "operator_modified";

export function resourceStatus(input: {
  resourceId: string | null;
  currentHash: string | null;
  bindingStockHash: string | null;
  latestStockHash: string;
}): ManagedResourceStockStatus {
  if (!input.resourceId || !input.currentHash) return "missing";
  if (input.currentHash === input.latestStockHash) return "stock_current";
  if (input.bindingStockHash && input.currentHash === input.bindingStockHash) {
    return "stock_update_available";
  }
  return "operator_modified";
}
