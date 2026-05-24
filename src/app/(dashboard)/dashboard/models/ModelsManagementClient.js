"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, Toggle } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { useNotificationStore } from "@/store/notificationStore";

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

function normalizeCatalog(data) {
  return {
    providers: Array.isArray(data?.providers) ? data.providers : [],
    totals: data?.totals || { providers: 0, models: 0, disabled: 0 },
  };
}

export default function ModelsManagementClient() {
  const [catalog, setCatalog] = useState({ providers: [], totals: { providers: 0, models: 0, disabled: 0 } });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState({});
  const notify = useNotificationStore();

  const fetchCatalog = async ({ quiet = false } = {}) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);

    try {
      const response = await fetch("/api/models?view=management", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Failed to load models");
      setCatalog(normalizeCatalog(data));
    } catch (error) {
      notify.error(error.message || "Failed to load models");
      setCatalog({ providers: [], totals: { providers: 0, models: 0, disabled: 0 } });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchCatalog();
  }, []);

  const filteredProviders = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalog.providers;

    return catalog.providers
      .map((group) => {
        const providerMatch =
          group.provider.name.toLowerCase().includes(needle) ||
          group.provider.alias.toLowerCase().includes(needle);
        const models = group.models.filter((model) => {
          return (
            providerMatch ||
            model.clientId.toLowerCase().includes(needle) ||
            model.id.toLowerCase().includes(needle) ||
            model.name.toLowerCase().includes(needle) ||
            (typeLabels[model.type] || model.type || "").toLowerCase().includes(needle)
          );
        });

        return models.length > 0 ? { ...group, models } : null;
      })
      .filter(Boolean);
  }, [catalog.providers, query]);

  const setModelDisabled = (providerAlias, modelId, disabled) => {
    setCatalog((current) => {
      let disabledDelta = 0;
      const providers = current.providers.map((group) => {
        if (group.provider.alias !== providerAlias) return group;
        return {
          ...group,
          models: group.models.map((model) => {
            if (model.id !== modelId || model.disabled === disabled) return model;
            disabledDelta += disabled ? 1 : -1;
            return { ...model, disabled };
          }),
        };
      });

      return {
        ...current,
        providers,
        totals: {
          ...current.totals,
          disabled: Math.max(0, (current.totals.disabled || 0) + disabledDelta),
        },
      };
    });
  };

  const handleToggle = async (providerAlias, model, enabled) => {
    const disabled = !enabled;
    const key = `${providerAlias}/${model.id}`;
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
      notify.success(disabled ? "Model disabled" : "Model enabled");
    } catch (error) {
      setModelDisabled(providerAlias, model.id, !disabled);
      notify.error(error.message || "Failed to update model");
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-text-main">Models</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="info" size="sm" dot>{catalog.totals.providers} Providers</Badge>
            <Badge variant="success" size="sm" dot>{catalog.totals.models - catalog.totals.disabled} Enabled</Badge>
            <Badge variant={catalog.totals.disabled > 0 ? "warning" : "default"} size="sm" dot>
              {catalog.totals.disabled} Disabled
            </Badge>
          </div>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[340px] sm:flex-row">
          <div className="relative flex-1">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">
              search
            </span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models"
              className="h-10 w-full rounded-[10px] border border-border bg-surface pl-10 pr-3 text-sm text-text-main outline-none transition focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/15"
            />
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
        <div className="flex flex-col gap-4">
          {filteredProviders.map((group) => (
            <Card
              key={group.provider.id}
              padding="md"
              className="overflow-hidden"
              title={group.provider.name}
              subtitle={`${group.provider.alias} · ${group.models.length} models`}
              action={
                <ProviderIcon
                  src={`/providers/${group.provider.id}.png`}
                  alt={group.provider.name}
                  size={32}
                  className="rounded-lg object-contain"
                  fallbackText={group.provider.textIcon}
                  fallbackColor={group.provider.color}
                />
              }
            >
              <div className="divide-y divide-border-subtle">
                {group.models.map((model) => {
                  const pendingKey = `${group.provider.alias}/${model.id}`;
                  const typeLabel = typeLabels[model.type] || model.type || "Model";
                  return (
                    <div
                      key={model.clientId}
                      className="flex min-w-0 flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <code className="min-w-0 break-all rounded-md bg-bg px-2 py-1 text-xs font-semibold text-text-main">
                            {model.clientId}
                          </code>
                          <Badge variant={model.disabled ? "warning" : "success"} size="sm" dot>
                            {model.disabled ? "Disabled" : "Enabled"}
                          </Badge>
                          <Badge variant="default" size="sm">{typeLabel}</Badge>
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                          <span className="truncate">{model.name}</span>
                          <span>·</span>
                          <span>{group.provider.name}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                        <span className="text-xs font-medium text-text-muted">
                          {model.disabled ? "Off" : "On"}
                        </span>
                        <Toggle
                          checked={!model.disabled}
                          disabled={!!pending[pendingKey]}
                          onChange={(enabled) => handleToggle(group.provider.alias, model, enabled)}
                          size="sm"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
