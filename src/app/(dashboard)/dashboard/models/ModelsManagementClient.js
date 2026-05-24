"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, Skeleton, Toggle } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import {
  ANTHROPIC_COMPATIBLE_PREFIX,
  OPENAI_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { useNotificationStore } from "@/store/notificationStore";

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "nameAZ", label: "Name A\u2013Z" },
  { value: "nameZA", label: "Name Z\u2013A" },
];

// Returns a numeric recency score for a model ID.
// Higher = newer. Uses embedded YYYYMMDD dates (highest priority)
// then decimal version numbers (e.g. "5.4" → 5400) then plain integers.
// Never invents dates — returns 0 when no version info is found.
function getModelRecencyScore(id) {
  const s = String(id).toLowerCase();

  // 8-digit date pattern YYYYMMDD (e.g. claude-opus-4-20250514)
  const dates = s.match(/\d{8}/g);
  if (dates) {
    for (const d of dates) {
      const y = +d.slice(0, 4), mo = +d.slice(4, 6), dy = +d.slice(6, 8);
      if (y >= 2020 && y <= 2035 && mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        return 1_000_000 + y * 10000 + mo * 100 + dy;
      }
    }
  }

  // Decimal version X.Y (e.g. "5.4", "3.1", "2.5")
  const vm = [...s.matchAll(/(\d+)\.(\d+)/g)];
  if (vm.length > 0) {
    return Math.max(...vm.map((m) => +m[1] * 1000 + +m[2]));
  }

  // Single integers (e.g. "o3", "o4-mini")
  const nm = s.match(/\d+/g);
  if (nm) return Math.max(...nm.map(Number)) * 10;

  return 0;
}

function sortModels(models, order) {
  const arr = [...models];
  switch (order) {
    case "newest":
      return arr.sort((a, b) => {
        const diff = getModelRecencyScore(b.id) - getModelRecencyScore(a.id);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
    case "oldest":
      return arr.sort((a, b) => {
        const diff = getModelRecencyScore(a.id) - getModelRecencyScore(b.id);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
    case "nameAZ":
      return arr.sort((a, b) => a.name.localeCompare(b.name));
    case "nameZA":
      return arr.sort((a, b) => b.name.localeCompare(a.name));
    default:
      return arr;
  }
}

const typeLabels = {
  llm: "Chat",
  image: "Image",
  imageToText: "Vision",
  tts: "TTS",
  stt: "STT",
  embedding: "Embedding",
  webSearch: "Search",
  webFetch: "Fetch",
};

const authLabels = {
  apikey: "API Key",
  oauth: "OAuth",
  cookie: "Cookie",
  none: "No auth",
  compatible: "Compatible",
  unknown: "Connection",
};

function modelTypeLabel(type) {
  return typeLabels[type] || type || "Model";
}

function getCatalogTotals(providers) {
  return providers.reduce(
    (totals, group) => {
      const totalModels = group.models.length;
      const modelDisabled = group.models.filter((model) => model.disabled).length;
      const providerDisabled = group.provider.disabled === true;

      totals.providers += 1;
      totals.models += totalModels;
      totals.disabled += modelDisabled;
      totals.disabledProviders += providerDisabled ? 1 : 0;
      totals.enabledModels += providerDisabled ? 0 : totalModels - modelDisabled;
      return totals;
    },
    { providers: 0, models: 0, disabled: 0, disabledProviders: 0, enabledModels: 0 },
  );
}

function normalizeCatalog(data) {
  const providers = Array.isArray(data?.providers)
    ? data.providers.map((group) => {
        const models = Array.isArray(group.models) ? group.models : [];
        const modelDisabled = models.filter((model) => model.disabled).length;
        const providerDisabled = group.provider?.disabled === true;
        return {
          ...group,
          provider: {
            ...(group.provider || {}),
            disabled: providerDisabled,
            totalModels: models.length,
            disabledModels: modelDisabled,
            enabledModels: providerDisabled ? 0 : models.length - modelDisabled,
          },
          models,
        };
      })
    : [];

  return { providers, totals: getCatalogTotals(providers) };
}

function matchesProvider(group, needle) {
  if (!needle) return true;
  return (
    group.provider.name.toLowerCase().includes(needle) ||
    group.provider.alias.toLowerCase().includes(needle) ||
    (authLabels[group.provider.authType] || group.provider.authType || "").toLowerCase().includes(needle)
  );
}

function matchesModel(model, needle) {
  if (!needle) return true;
  return (
    model.clientId.toLowerCase().includes(needle) ||
    model.id.toLowerCase().includes(needle) ||
    model.name.toLowerCase().includes(needle) ||
    modelTypeLabel(model.type).toLowerCase().includes(needle)
  );
}

function updateProviderStats(group) {
  const totalModels = group.models.length;
  const disabledModels = group.models.filter((model) => model.disabled).length;
  return {
    ...group,
    provider: {
      ...group.provider,
      totalModels,
      disabledModels,
      enabledModels: group.provider.disabled ? 0 : totalModels - disabledModels,
    },
  };
}

export default function ModelsManagementClient() {
  const [catalog, setCatalog] = useState({ providers: [], totals: getCatalogTotals([]) });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [pending, setPending] = useState({});
  const [sortOrder, setSortOrder] = useState("newest");
  const notifySuccess = useNotificationStore((s) => s.success);
  const notifyError = useNotificationStore((s) => s.error);
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  useEffect(() => {
    registerSearch("Search models...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  const fetchCatalog = useCallback(async ({ quiet = false } = {}) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);

    try {
      const response = await fetch("/api/models?view=management", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Failed to load models");
      setCatalog(normalizeCatalog(data));
    } catch (error) {
      notifyError(error.message || "Failed to load models");
      setCatalog({ providers: [], totals: getCatalogTotals([]) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [notifyError]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      fetchCatalog();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [fetchCatalog]);

  const filteredProviders = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    const groups = !needle
      ? catalog.providers
      : catalog.providers
          .map((group) => {
            const providerMatch = matchesProvider(group, needle);
            const models = group.models.filter((model) => providerMatch || matchesModel(model, needle));
            return models.length > 0 ? { ...group, models } : null;
          })
          .filter(Boolean);

    return groups.map((group) => ({
      ...group,
      models: sortModels(group.models, sortOrder),
    }));
  }, [catalog.providers, searchQuery, sortOrder]);

  const setModelDisabled = (providerAlias, modelId, disabled) => {
    setCatalog((current) => {
      const providers = current.providers.map((group) => {
        if (group.provider.alias !== providerAlias) return group;
        return updateProviderStats({
          ...group,
          models: group.models.map((model) =>
            model.id === modelId ? { ...model, disabled } : model,
          ),
        });
      });
      return { providers, totals: getCatalogTotals(providers) };
    });
  };

  const setProviderDisabled = (providerAlias, disabled) => {
    setCatalog((current) => {
      const providers = current.providers.map((group) => {
        if (group.provider.alias !== providerAlias) return group;
        return updateProviderStats({
          ...group,
          provider: { ...group.provider, disabled },
        });
      });
      return { providers, totals: getCatalogTotals(providers) };
    });
  };

  const handleModelToggle = async (providerAlias, model, enabled) => {
    const disabled = !enabled;
    const key = `model:${providerAlias}/${model.id}`;
    setPending((current) => ({ ...current, [key]: true }));
    setModelDisabled(providerAlias, model.id, disabled);

    try {
      const url = disabled
        ? "/api/models/disabled"
        : `/api/models/disabled?providerAlias=${encodeURIComponent(providerAlias)}&id=${encodeURIComponent(model.id)}`;
      const response = await fetch(url, {
        method: disabled ? "POST" : "DELETE",
        headers: disabled ? { "Content-Type": "application/json" } : undefined,
        body: disabled ? JSON.stringify({ providerAlias, ids: [model.id] }) : undefined,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Failed to update model");
      notifySuccess(disabled ? "Model disabled" : "Model enabled");
    } catch (error) {
      setModelDisabled(providerAlias, model.id, !disabled);
      notifyError(error.message || "Failed to update model");
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  const handleProviderToggle = async (provider, enabled) => {
    const providerAlias = provider.alias;
    const disabled = !enabled;
    const key = `provider:${providerAlias}`;
    setPending((current) => ({ ...current, [key]: true }));
    setProviderDisabled(providerAlias, disabled);

    try {
      const response = await fetch(
        disabled
          ? "/api/models/disabled-providers"
          : `/api/models/disabled-providers?providerAlias=${encodeURIComponent(providerAlias)}&providerId=${encodeURIComponent(provider.id)}`,
        {
          method: disabled ? "POST" : "DELETE",
          headers: disabled ? { "Content-Type": "application/json" } : undefined,
          body: disabled ? JSON.stringify({ providerAlias, providerId: provider.id }) : undefined,
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Failed to update provider");
      notifySuccess(disabled ? "Provider disabled" : "Provider enabled");
    } catch (error) {
      setProviderDisabled(providerAlias, !disabled);
      notifyError(error.message || "Failed to update provider");
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-[14px]" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryMetric
          icon="dns"
          label="Providers"
          value={catalog.totals.providers}
          variant="info"
        />
        <SummaryMetric
          icon="check_circle"
          label="Enabled Models"
          value={catalog.totals.enabledModels}
          variant="success"
        />
        <SummaryMetric
          icon="visibility_off"
          label="Disabled Models"
          value={catalog.totals.disabled}
          variant={catalog.totals.disabled > 0 ? "warning" : "default"}
        />
        <SummaryMetric
          icon="block"
          label="Off Providers"
          value={catalog.totals.disabledProviders}
          variant={catalog.totals.disabledProviders > 0 ? "error" : "default"}
        />
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <div className="relative w-full sm:w-auto">
          <span className="material-symbols-outlined pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-text-muted">
            sort
          </span>
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            className="w-full appearance-none rounded-[10px] border border-transparent bg-surface-2 py-2 pl-8 pr-8 text-sm text-text-main transition-all focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:w-auto"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[16px] text-text-muted">
            expand_more
          </span>
        </div>
        <Button
          variant="secondary"
          icon="refresh"
          onClick={() => fetchCatalog({ quiet: true })}
          loading={refreshing}
          className="w-full sm:w-auto"
        >
          Refresh
        </Button>
      </div>

      {filteredProviders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <span className="material-symbols-outlined mb-3 block text-[40px] text-text-muted">
            search_off
          </span>
          <p className="text-sm font-medium text-text-main">No models found</p>
          <p className="mt-1 text-xs text-text-muted">Try adjusting your search or sort settings</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredProviders.map((group) => (
            <ProviderModelCard
              key={group.provider.id}
              group={group}
              isExpanded={!!expanded[group.provider.alias] || !!searchQuery.trim()}
              pending={pending}
              onToggleProvider={handleProviderToggle}
              onToggleModel={handleModelToggle}
              onToggleExpanded={() =>
                setExpanded((current) => ({
                  ...current,
                  [group.provider.alias]: !current[group.provider.alias],
                }))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryMetric({ icon, label, value, variant = "default" }) {
  const iconStyles = {
    default: { icon: "text-text-muted", bg: "bg-surface-2" },
    info: { icon: "text-blue-500", bg: "bg-blue-500/10" },
    success: { icon: "text-green-500", bg: "bg-green-500/10" },
    warning: { icon: "text-yellow-500", bg: "bg-yellow-500/10" },
    error: { icon: "text-red-500", bg: "bg-red-500/10" },
  };
  const { icon: iconCls, bg: bgCls } = iconStyles[variant] || iconStyles.default;

  return (
    <Card padding="sm">
      <div className="flex items-center gap-3">
        <div className={`shrink-0 rounded-[10px] p-2.5 ${bgCls}`}>
          <span className={`material-symbols-outlined text-[22px] ${iconCls}`}>{icon}</span>
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-bold tabular-nums text-text-main leading-none">{value}</div>
          <div className="mt-0.5 text-xs text-text-muted truncate">{label}</div>
        </div>
      </div>
    </Card>
  );
}

function ProviderModelCard({
  group,
  isExpanded,
  pending,
  onToggleProvider,
  onToggleModel,
  onToggleExpanded,
}) {
  const provider = group.provider;
  const providerPendingKey = `provider:${provider.alias}`;
  const providerDisabled = provider.disabled === true;
  const modelPreview = isExpanded ? group.models : group.models.slice(0, 4);
  const isOpenAICompatible = provider.id?.startsWith(OPENAI_COMPATIBLE_PREFIX);
  const isAnthropicCompatible = provider.id?.startsWith(ANTHROPIC_COMPATIBLE_PREFIX);
  const iconPath = isOpenAICompatible
    ? provider.apiType === "responses"
      ? "/providers/oai-r.png"
      : "/providers/oai-cc.png"
    : isAnthropicCompatible
      ? "/providers/anthropic-m.png"
      : `/providers/${provider.id}.png`;

  return (
    <Card
      padding="sm"
      className={`h-fit transition-opacity ${providerDisabled ? "opacity-60" : ""}`}
    >
      {/* Provider header */}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-[10px]"
            style={{ backgroundColor: provider.color?.length > 7 ? provider.color : `${provider.color || "#6b7280"}18` }}
          >
            <ProviderIcon
              src={iconPath}
              alt={provider.name}
              size={28}
              className="max-h-7 max-w-7 rounded-md object-contain"
              fallbackText={provider.textIcon || provider.alias?.slice(0, 2).toUpperCase()}
              fallbackColor={provider.color}
            />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-text-main">{provider.name}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant={providerDisabled ? "error" : "success"} size="sm" dot>
                {providerDisabled ? "Off" : "On"}
              </Badge>
              <Badge variant="default" size="sm">{provider.alias}</Badge>
              <Badge variant="default" size="sm">
                {authLabels[provider.authType] || provider.authType || "Connection"}
              </Badge>
            </div>
          </div>
        </div>
        <Toggle
          size="sm"
          checked={!providerDisabled}
          disabled={!!pending[providerPendingKey]}
          onChange={(enabled) => onToggleProvider(provider, enabled)}
        />
      </div>

      {/* Stats */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Metric label="Total" value={provider.totalModels} />
        <Metric label="Enabled" value={provider.enabledModels} muted={providerDisabled} />
        <Metric label="Disabled" value={provider.disabledModels} warn={provider.disabledModels > 0} />
      </div>

      {/* Status + expand toggle */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-text-muted">
          {providerDisabled
            ? "Hidden from every /v1/models endpoint"
            : provider.disabledModels > 0
              ? "Some models are individually hidden"
              : "All listed models are discoverable"}
        </p>
        <button
          type="button"
          onClick={onToggleExpanded}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-text-muted transition hover:bg-surface-2 hover:text-text-main"
        >
          {isExpanded ? "Hide" : "Models"}
          <span className="material-symbols-outlined text-[16px]">
            {isExpanded ? "expand_less" : "expand_more"}
          </span>
        </button>
      </div>

      {/* Model list */}
      <div className="mt-3 overflow-hidden rounded-[10px] border border-border-subtle">
        {modelPreview.map((model) => {
          const modelPendingKey = `model:${provider.alias}/${model.id}`;
          return (
            <div
              key={model.clientId}
              className="flex min-w-0 items-center justify-between gap-3 border-b border-border-subtle p-3 last:border-b-0 hover:bg-surface-2/40 transition-colors"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <code className="max-w-full break-all rounded bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-text-main">
                    {model.clientId}
                  </code>
                  <Badge variant={model.disabled ? "warning" : "success"} size="sm" dot>
                    {model.disabled ? "Off" : "On"}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-text-muted">
                  <span className="truncate">{model.name}</span>
                  <span className="text-border-subtle">·</span>
                  <span>{modelTypeLabel(model.type)}</span>
                </div>
              </div>
              <Toggle
                size="sm"
                checked={!model.disabled}
                disabled={!!pending[modelPendingKey]}
                onChange={(enabled) => onToggleModel(provider.alias, model, enabled)}
              />
            </div>
          );
        })}
        {!isExpanded && group.models.length > modelPreview.length && (
          <button
            type="button"
            onClick={onToggleExpanded}
            className="flex w-full items-center justify-center gap-1.5 p-2.5 text-xs font-semibold text-text-muted transition hover:bg-surface-2/50 hover:text-text-main"
          >
            Show {group.models.length - modelPreview.length} more
            <span className="material-symbols-outlined text-[15px]">expand_more</span>
          </button>
        )}
      </div>
    </Card>
  );
}

function Metric({ label, value, muted = false, warn = false }) {
  return (
    <div className="rounded-[8px] border border-border-subtle bg-bg px-2.5 py-2">
      <div className={`text-base font-semibold tabular-nums ${warn ? "text-yellow-600 dark:text-yellow-400" : muted ? "text-text-muted" : "text-text-main"}`}>
        {value}
      </div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
    </div>
  );
}
