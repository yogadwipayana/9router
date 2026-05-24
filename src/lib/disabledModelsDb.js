// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
  getDisabledProviders, disableProvider, enableProvider, isProviderDisabled,
} from "@/lib/db/index.js";
