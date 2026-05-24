"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, Toggle } from "@/shared/components";
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
      <div className="flex flex-col gap-4">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="info" size="sm" dot>
              {catalog.totals.providers} Providers
            </Badge>
            <Badge variant="success" size="sm" dot>
              {catalog.totals.enabledModels} Enabled models
            </Badge>
            <Badge variant={catalog.totals.disabled > 0 ? "warning" : "default"} size="sm" dot>
              {catalog.totals.disabled} Model disabled
            </Badge>
            <Badge variant={catalog.totals.disabledProviders > 0 ? "error" : "default"} size="sm" dot>
              {catalog.totals.disabledProviders} Provider disabled
            </Badge>
          </div>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
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
      </div>

      {filteredProviders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-muted">
          <span className="material-symbols-outlined mb-2 block text-[32px]">search_off</span>
          No models found
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
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
      padding="xs"
      className={`h-fit transition-colors ${providerDisabled ? "opacity-70" : "hover:bg-black/[0.01] dark:hover:bg-white/[0.01]"}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: provider.color?.length > 7 ? provider.color : `${provider.color || "#6b7280"}15` }}
          >
            <ProviderIcon
              src={iconPath}
              alt={provider.name}
              size={32}
              className="max-h-8 max-w-8 rounded-lg object-contain"
              fallbackText={provider.textIcon || provider.alias?.slice(0, 2).toUpperCase()}
              fallbackColor={provider.color}
            />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-text-main">{provider.name}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              <Badge variant={providerDisabled ? "error" : "success"} size="sm" dot>
                {providerDisabled ? "Provider off" : "Provider on"}
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

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Metric label="Total" value={provider.totalModels} />
        <Metric label="Enabled" value={provider.enabledModels} muted={providerDisabled} />
        <Metric label="Disabled" value={provider.disabledModels} warn={provider.disabledModels > 0} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0 text-xs text-text-muted">
          {providerDisabled
            ? "Hidden from every /v1/models endpoint"
            : provider.disabledModels > 0
              ? "Some models are individually hidden"
              : "All listed models are discoverable"}
        </div>
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

      <div className="mt-3 divide-y divide-border-subtle rounded-[10px] border border-border-subtle bg-bg/50">
        {modelPreview.map((model) => {
          const modelPendingKey = `model:${provider.alias}/${model.id}`;
          return (
            <div key={model.clientId} className="flex min-w-0 items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <code className="max-w-full break-all rounded bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-text-main">
                    {model.clientId}
                  </code>
                  <Badge variant={model.disabled ? "warning" : "success"} size="sm" dot>
                    {model.disabled ? "Model off" : "Model on"}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                  <span className="truncate">{model.name}</span>
                  <span>-</span>
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
            className="flex w-full items-center justify-center gap-1.5 p-2 text-xs font-semibold text-text-muted transition hover:bg-surface-2 hover:text-text-main"
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
    <div className="rounded-lg border border-border-subtle bg-bg px-2 py-2">
      <div className={`text-base font-semibold tabular-nums ${warn ? "text-yellow-600 dark:text-yellow-400" : muted ? "text-text-muted" : "text-text-main"}`}>
        {value}
      </div>
      <div className="text-[10px] font-medium uppercase text-text-muted">{label}</div>
    </div>
  );
}
