// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  getEnabledModels, getEnabledByProvider, enableModels, disableModels,
  getEnabledProviders, enableProvider, disableProvider, isProviderEnabled,
} from "@/lib/db/index.js";
