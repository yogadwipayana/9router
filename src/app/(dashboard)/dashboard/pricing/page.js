"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CardSkeleton, Skeleton } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import {
  ANTHROPIC_COMPATIBLE_PREFIX,
  OPENAI_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { useNotificationStore } from "@/store/notificationStore";

const PRICING_FIELDS = [
  { key: "input",  label: "Input" },
  { key: "output", label: "Output" },
];

// ── helpers ──────────────────────────────────────────────────────────────────

function getEnabledGroups(catalog) {
  return (catalog?.providers ?? [])
    .filter((g) => !g.provider?.disabled)
    .map((g) => ({ ...g, models: g.models.filter((m) => !m.disabled) }))
    .filter((g) => g.models.length > 0);
}

function getFieldValue(pricingData, providerAlias, modelId, field) {
  return pricingData?.[providerAlias]?.[modelId]?.[field] ?? 0;
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function PricingPage() {
  const [groups, setGroups]           = useState([]);
  const [pricingData, setPricingData] = useState({});
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [dirty, setDirty]             = useState(false);

  const notifySuccess    = useNotificationStore((s) => s.success);
  const notifyError      = useNotificationStore((s) => s.error);
  const searchQuery      = useHeaderSearchStore((s) => s.query);
  const registerSearch   = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  useEffect(() => {
    registerSearch("Search models...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  // ── load ────────────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [catalogRes, pricingRes] = await Promise.all([
        fetch("/api/models?view=management", { cache: "no-store" }),
        fetch("/api/pricing"),
      ]);
      const catalogJson = await catalogRes.json();
      const pricing     = pricingRes.ok ? await pricingRes.json() : {};

      setGroups(getEnabledGroups(catalogJson));
      setPricingData(pricing);
      setDirty(false);
    } catch {
      notifyError("Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    const id = window.setTimeout(() => loadData(), 0);
    return () => window.clearTimeout(id);
  }, [loadData]);

  // ── pricing change ───────────────────────────────────────────────────────────

  const handleChange = useCallback((providerAlias, modelId, field, value) => {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0) return;
    setPricingData((prev) => ({
      ...prev,
      [providerAlias]: {
        ...(prev[providerAlias] ?? {}),
        [modelId]: {
          ...(prev[providerAlias]?.[modelId] ?? {}),
          [field]: num,
        },
      },
    }));
    setDirty(true);
  }, []);

  // ── save ─────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pricingData),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setPricingData(await res.json());
      setDirty(false);
      notifySuccess("Pricing saved");
    } catch (err) {
      notifyError(err.message || "Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  // ── reset per model ──────────────────────────────────────────────────────────

  const handleResetModel = useCallback(async (providerAlias, modelId) => {
    try {
      const res = await fetch(
        `/api/pricing?provider=${encodeURIComponent(providerAlias)}&model=${encodeURIComponent(modelId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error((await res.json()).error);
      setPricingData(await res.json());
      notifySuccess("Pricing reset to defaults");
    } catch (err) {
      notifyError(err.message || "Failed to reset pricing");
    }
  }, [notifyError, notifySuccess]);

  // ── filter ──────────────────────────────────────────────────────────────────

  const filteredGroups = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => {
        const provMatch =
          g.provider.name.toLowerCase().includes(needle) ||
          g.provider.alias.toLowerCase().includes(needle);
        const models = g.models.filter(
          (m) =>
            provMatch ||
            m.id.toLowerCase().includes(needle) ||
            m.name.toLowerCase().includes(needle) ||
            m.clientId.toLowerCase().includes(needle),
        );
        return models.length ? { ...g, models } : null;
      })
      .filter(Boolean);
  }, [groups, searchQuery]);

  const totalEnabled = useMemo(
    () => groups.reduce((s, g) => s + g.models.length, 0),
    [groups],
  );

  // ── render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-[76px] rounded-[14px]" />
          <Skeleton className="h-[76px] rounded-[14px]" />
        </div>
        <Skeleton className="h-10 rounded-[10px]" />
        <div className="flex flex-col gap-4">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Summary metrics */}
      <div className="grid grid-cols-2 gap-3">
        <SummaryMetric
          icon="dns"
          label="Providers"
          value={groups.length}
          variant="info"
        />
        <SummaryMetric
          icon="check_circle"
          label="Enabled Models"
          value={totalEnabled}
          variant="success"
        />
      </div>

      {/* Info callout + toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 rounded-[10px] border border-blue-500/20 bg-blue-500/5 px-3 py-2.5">
          <span className="material-symbols-outlined shrink-0 text-[16px] text-blue-500">info</span>
          <p className="text-xs text-text-muted">
            Rates are in <strong className="text-text-main">$/1M tokens</strong>. Only enabled models are shown. Changes apply to cost tracking.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" icon="refresh" size="sm" onClick={loadData}>
            Refresh
          </Button>
          <Button
            variant="primary"
            icon="save"
            size="sm"
            onClick={handleSave}
            loading={saving}
            disabled={!dirty}
          >
            Save Changes
          </Button>
        </div>
      </div>

      {/* Unsaved changes banner */}
      {dirty && (
        <div className="flex items-center justify-between gap-3 rounded-[10px] border border-yellow-500/30 bg-yellow-500/10 px-4 py-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-yellow-600 dark:text-yellow-400">
            <span className="material-symbols-outlined text-[16px]">edit_note</span>
            You have unsaved pricing changes
          </div>
          <button
            type="button"
            onClick={loadData}
            className="text-xs text-text-muted underline underline-offset-2 transition-colors hover:text-text-main"
          >
            Discard
          </button>
        </div>
      )}

      {/* Content */}
      {filteredGroups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <span className="material-symbols-outlined mb-3 block text-[40px] text-text-muted">
            sell
          </span>
          <p className="text-sm font-medium text-text-main">No enabled models found</p>
          <p className="mt-1 text-xs text-text-muted">
            Enable models from the Models page to configure pricing
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {filteredGroups.map((group) => (
            <ProviderPricingCard
              key={group.provider.id}
              group={group}
              pricingData={pricingData}
              onChange={handleChange}
              onResetModel={handleResetModel}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── summary metric ────────────────────────────────────────────────────────────

function SummaryMetric({ icon, label, value, variant = "default" }) {
  const iconStyles = {
    default: { icon: "text-text-muted", bg: "bg-surface-2" },
    info:    { icon: "text-blue-500",   bg: "bg-blue-500/10" },
    success: { icon: "text-green-500",  bg: "bg-green-500/10" },
    warning: { icon: "text-yellow-500", bg: "bg-yellow-500/10" },
    error:   { icon: "text-red-500",    bg: "bg-red-500/10" },
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

// ── provider card ─────────────────────────────────────────────────────────────

function ProviderPricingCard({ group, pricingData, onChange, onResetModel }) {
  const provider = group.provider;
  const isOpenAICompatible    = provider.id?.startsWith(OPENAI_COMPATIBLE_PREFIX);
  const isAnthropicCompatible = provider.id?.startsWith(ANTHROPIC_COMPATIBLE_PREFIX);
  const iconPath = isOpenAICompatible
    ? provider.apiType === "responses"
      ? "/providers/oai-r.png"
      : "/providers/oai-cc.png"
    : isAnthropicCompatible
      ? "/providers/anthropic-m.png"
      : `/providers/${provider.id}.png`;

  return (
    <Card padding="none" className="overflow-hidden">
      {/* provider header */}
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{
            backgroundColor:
              provider.color?.length > 7
                ? provider.color
                : `${provider.color || "#6b7280"}18`,
          }}
        >
          <ProviderIcon
            src={iconPath}
            alt={provider.name}
            size={26}
            className="max-h-6 max-w-6 rounded object-contain"
            fallbackText={provider.textIcon || provider.alias?.slice(0, 2).toUpperCase()}
            fallbackColor={provider.color}
          />
        </div>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-text-main">{provider.name}</span>
          <span className="ml-2 inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-text-muted">
            {provider.alias}
          </span>
        </div>
        <span className="shrink-0 text-xs text-text-muted">
          {group.models.length} model{group.models.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* pricing table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[580px] text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-2/50">
              <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Model
              </th>
              {PRICING_FIELDS.map((f) => (
                <th
                  key={f.key}
                  className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  {f.label} <span className="normal-case font-normal opacity-60">$/1M</span>
                </th>
              ))}
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {group.models.map((model) => (
              <ModelPricingRow
                key={model.clientId}
                model={model}
                providerAlias={provider.alias}
                pricingData={pricingData}
                onChange={onChange}
                onReset={onResetModel}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── model row ─────────────────────────────────────────────────────────────────

function ModelPricingRow({ model, providerAlias, pricingData, onChange, onReset }) {
  // local draft so inputs feel snappy
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(
      PRICING_FIELDS.map((f) => [
        f.key,
        String(getFieldValue(pricingData, providerAlias, model.id, f.key)),
      ]),
    ),
  );

  // sync when pricingData changes externally (e.g. after reset / save)
  const prevDataRef = useRef(pricingData);
  useEffect(() => {
    if (prevDataRef.current !== pricingData) {
      prevDataRef.current = pricingData;
      setDraft(
        Object.fromEntries(
          PRICING_FIELDS.map((f) => [
            f.key,
            String(getFieldValue(pricingData, providerAlias, model.id, f.key)),
          ]),
        ),
      );
    }
  }, [pricingData, providerAlias, model.id]);

  const handleInput = (field, value) => {
    setDraft((d) => ({ ...d, [field]: value }));
  };

  const handleBlur = (field, value) => {
    const num = parseFloat(value);
    if (!isNaN(num) && num >= 0) {
      onChange(providerAlias, model.id, field, num);
    } else {
      // revert draft to stored value
      setDraft((d) => ({
        ...d,
        [field]: String(getFieldValue(pricingData, providerAlias, model.id, field)),
      }));
    }
  };

  return (
    <tr className="group transition-colors hover:bg-surface-2/30">
      {/* model name */}
      <td className="px-4 py-2.5">
        <div className="flex flex-col gap-0.5">
          <code className="inline-block max-w-[260px] truncate rounded bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-text-main">
            {model.clientId}
          </code>
          <span className="text-[11px] text-text-muted">{model.name}</span>
        </div>
      </td>

      {/* price inputs */}
      {PRICING_FIELDS.map((f) => (
        <td key={f.key} className="px-3 py-2.5 text-right">
          <div className="relative inline-flex items-center">
            <span className="pointer-events-none absolute left-2 text-[11px] text-text-muted">$</span>
            <input
              type="number"
              step="0.001"
              min="0"
              value={draft[f.key]}
              onChange={(e) => handleInput(f.key, e.target.value)}
              onBlur={(e) => handleBlur(f.key, e.target.value)}
              className="w-[5.5rem] rounded-[8px] border border-transparent bg-surface-2 py-1 pl-5 pr-2 text-right text-xs text-text-main transition-all focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
        </td>
      ))}

      {/* reset */}
      <td className="px-2 py-2.5 text-right">
        <button
          type="button"
          title="Reset to defaults"
          onClick={() => onReset(providerAlias, model.id)}
          className="inline-flex items-center justify-center rounded-lg p-1.5 text-text-muted opacity-0 transition hover:bg-surface-3 hover:text-text-main group-hover:opacity-100"
        >
          <span className="material-symbols-outlined text-[15px]">restart_alt</span>
        </button>
      </td>
    </tr>
  );
}
