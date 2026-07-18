"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, ConfirmModal, Input, Modal, SegmentedControl, Select, Skeleton } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/utils/cn";

const KEYS_PER_PAGE = 10;

const DURATION_UNITS = [
  { value: "minutes", label: "Minutes", seconds: 60 },
  { value: "hours", label: "Hours", seconds: 3600 },
  { value: "days", label: "Days", seconds: 86400 },
];

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "exhausted", label: "Exhausted" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "budgetHigh", label: "Budget: high to low" },
  { value: "budgetLow", label: "Budget: low to high" },
];

const STATUS_STYLES = {
  active: "bg-green-500/10 text-green-600 dark:text-green-400",
  expired: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  exhausted: "bg-surface-2 text-text-muted",
  disabled: "bg-surface-2 text-text-muted",
};

function formatUsd(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n < 1 ? 3 : 2,
    maximumFractionDigits: n < 1 ? 3 : 2,
  }).format(n);
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatDuration(seconds) {
  const s = Number(seconds || 0);
  if (s % 86400 === 0) return `${s / 86400} day${s / 86400 === 1 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s / 3600 === 1 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s}s`;
}

function timeLeft(expiresAt) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

export default function TempKeyPage() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [durationValue, setDurationValue] = useState("24");
  const [durationUnit, setDurationUnit] = useState("hours");
  const [note, setNote] = useState("");
  const [createdKeys, setCreatedKeys] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [page, setPage] = useState(1);

  const { copied, copy } = useCopyToClipboard(2000);
  const notifySuccess = useNotificationStore((s) => s.success);
  const notifyError = useNotificationStore((s) => s.error);
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  useEffect(() => {
    registerSearch("Search temp keys...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/temp-key", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load temp keys");
      setKeys(data.keys || []);
    } catch (error) {
      notifyError(error.message || "Failed to load temp keys");
    } finally {
      setLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const filteredKeys = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    let list = keys;
    if (needle) {
      list = list.filter((k) =>
        (k.name || "").toLowerCase().includes(needle) ||
        k.key.toLowerCase().includes(needle) ||
        (k.note || "").toLowerCase().includes(needle)
      );
    }
    if (statusFilter !== "all") {
      list = list.filter((k) => k.status === statusFilter);
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case "oldest":
          return new Date(a.createdAt) - new Date(b.createdAt);
        case "budgetHigh":
          return Number(b.budgetUsd) - Number(a.budgetUsd);
        case "budgetLow":
          return Number(a.budgetUsd) - Number(b.budgetUsd);
        case "newest":
        default:
          return new Date(b.createdAt) - new Date(a.createdAt);
      }
    });
    return sorted;
  }, [keys, searchQuery, statusFilter, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filteredKeys.length / KEYS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * KEYS_PER_PAGE;
  const pagedKeys = filteredKeys.slice(pageStart, pageStart + KEYS_PER_PAGE);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, statusFilter, sortBy]);

  const summary = useMemo(() => {
    return keys.reduce((acc, k) => {
      acc.total += 1;
      if (k.status === "active") acc.active += 1;
      else acc.inactive += 1;
      acc.budget += Number(k.budgetUsd || 0);
      acc.spent += Number(k.spentUsd || 0);
      return acc;
    }, { total: 0, active: 0, inactive: 0, budget: 0, spent: 0 });
  }, [keys]);

  const budgetValue = Number(budget);
  const budgetError = budget !== "" && (!Number.isFinite(budgetValue) || budgetValue <= 0)
    ? "Budget must be greater than zero"
    : "";
  const durationNum = Math.floor(Number(durationValue));
  const durationError = durationValue !== "" && (!Number.isFinite(durationNum) || durationNum <= 0)
    ? "Duration must be greater than zero"
    : "";
  const canCreate =
    budget !== "" && Number.isFinite(budgetValue) && budgetValue > 0 &&
    durationValue !== "" && Number.isFinite(durationNum) && durationNum > 0;

  const openCreate = () => {
    setName("");
    setBudget("");
    setDurationValue("24");
    setDurationUnit("hours");
    setNote("");
    setCreatedKeys([]);
    setCreateOpen(true);
  };

  const createKey = async () => {
    if (!canCreate) return;
    const unit = DURATION_UNITS.find((u) => u.value === durationUnit) || DURATION_UNITS[1];
    const durationSeconds = durationNum * unit.seconds;
    setSaving(true);
    try {
      const res = await fetch("/api/temp-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          budgetUsd: budgetValue,
          durationSeconds,
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create temp key");
      const created = data.keys || [];
      notifySuccess(created.length === 1 ? "Temp key created" : `${created.length} temp keys created`);
      setCreatedKeys(created.map((k) => k.key));
      await loadKeys();
    } catch (error) {
      notifyError(error.message || "Failed to create temp key");
    } finally {
      setSaving(false);
    }
  };

  const deleteKey = (key) => {
    setConfirmState({
      title: "Delete Temp Key",
      message: `Delete this temporary key${key.name ? ` (${key.name})` : ""}? This cannot be undone.`,
      onConfirm: async () => {
        setConfirmLoading(true);
        try {
          const res = await fetch(`/api/temp-key/${key.id}`, { method: "DELETE" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to delete temp key");
          notifySuccess("Temp key deleted");
          setConfirmState(null);
          await loadKeys();
        } catch (error) {
          notifyError(error.message || "Failed to delete temp key");
        } finally {
          setConfirmLoading(false);
        }
      },
    });
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visibleIds = useMemo(() => pagedKeys.map((k) => k.id), [pagedKeys]);
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const bulkDelete = () => {
    const ids = visibleIds.filter((id) => selectedIds.has(id));
    if (ids.length === 0) return;
    setConfirmState({
      title: "Delete Temp Keys",
      message: `Delete ${ids.length} selected temp key${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
      onConfirm: async () => {
        setConfirmLoading(true);
        try {
          const res = await fetch("/api/temp-key", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to delete temp keys");
          notifySuccess(`${data.deleted} temp key${data.deleted === 1 ? "" : "s"} deleted`);
          setConfirmState(null);
          setSelectedIds(new Set());
          await loadKeys();
        } catch (error) {
          notifyError(error.message || "Failed to delete temp keys");
        } finally {
          setConfirmLoading(false);
        }
      },
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6 px-1 sm:px-0">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-[84px]" />
          <Skeleton className="h-[84px]" />
          <Skeleton className="h-[84px]" />
          <Skeleton className="h-[84px]" />
        </div>
        <Skeleton className="h-[420px]" />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard icon="timer" label="Temp Keys" value={summary.total} />
        <SummaryCard icon="check_circle" label="Active" value={summary.active} />
        <SummaryCard icon="account_balance_wallet" label="Total Budget" value={formatUsd(summary.budget)} />
        <SummaryCard icon="payments" label="Total Spent" value={formatUsd(summary.spent)} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 rounded-[10px] border border-border-subtle bg-surface px-3 py-2.5">
          <span className="material-symbols-outlined shrink-0 text-[16px] text-primary">info</span>
          <p className="text-xs text-text-muted">
            Temporary keys work at the same <code className="font-mono">/v1</code> endpoint. The lifetime clock starts on the first request.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" icon="refresh" size="sm" onClick={loadKeys}>
            Refresh
          </Button>
          <Button icon="add" size="sm" onClick={openCreate}>
            Create Temp Key
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
          size="sm"
          className="w-full sm:w-auto"
        />
        <Select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          options={SORT_OPTIONS}
          className="w-full sm:w-auto sm:min-w-[200px]"
        />
      </div>

      <Card padding="none" className="overflow-hidden">
        {filteredKeys.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <span className="material-symbols-outlined mb-3 block text-[40px] text-text-muted">timer</span>
            <p className="text-sm font-medium text-text-main">No temp keys found</p>
            <p className="mt-1 text-xs text-text-muted">Create a temporary key with a budget and time limit</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                {selectedVisibleCount > 0 ? `${selectedVisibleCount} selected` : "Select all"}
              </label>
              {selectedVisibleCount > 0 && (
                <Button variant="danger" size="sm" icon="delete" onClick={bulkDelete}>
                  Delete selected
                </Button>
              )}
            </div>
            <div className={cn("divide-y divide-border-subtle", totalPages > 1 && "md:min-h-[589px]")}>
              {pagedKeys.map((key) => (
                <TempKeyRow
                  key={key.id}
                  tempKey={key}
                  onDelete={deleteKey}
                  selected={selectedIds.has(key.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      <Pagination
        currentPage={safePage}
        pageSize={KEYS_PER_PAGE}
        totalItems={filteredKeys.length}
        onPageChange={setPage}
      />

      <Modal isOpen={createOpen} title="Create Temp Key" onClose={() => setCreateOpen(false)}>
        {createdKeys.length > 0 ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 rounded-[10px] border border-green-500/30 bg-green-500/10 px-3 py-2.5">
              <span className="material-symbols-outlined shrink-0 text-[18px] text-green-500">check_circle</span>
              <p className="text-sm text-text-main">
                {createdKeys.length === 1 ? "Temp key created" : `${createdKeys.length} temp keys created`}
              </p>
            </div>
            <textarea
              readOnly
              value={createdKeys.join("\n")}
              rows={Math.min(createdKeys.length, 10)}
              onFocus={(e) => e.target.select()}
              className="w-full resize-none rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-sm text-text-main focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
            <div className="flex gap-2">
              <Button
                onClick={() => copy(createdKeys.join("\n"), "bulk")}
                fullWidth
                icon={copied === "bulk" ? "check" : "content_copy"}
              >
                {copied === "bulk" ? "Copied" : "Copy all keys"}
              </Button>
              <Button onClick={() => setCreateOpen(false)} variant="ghost" fullWidth>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Input
              label="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Demo key, trial user, etc."
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-main">
                Budget <span className="ml-1 text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-text-muted">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="5.00"
                  className={cn(
                    "w-full rounded-[10px] border border-transparent bg-surface-2 py-2.5 pl-7 pr-3 text-[16px] text-text-main transition-all placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm",
                    budgetError && "border-red-500/40 ring-1 ring-red-500 focus:ring-red-500/40"
                  )}
                />
              </div>
              {budgetError && (
                <p className="flex items-center gap-1 text-xs text-red-500">
                  <span className="material-symbols-outlined text-[14px]">error</span>
                  {budgetError}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-main">
                Lifetime <span className="ml-1 text-red-500">*</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={durationValue}
                  onChange={(e) => setDurationValue(e.target.value)}
                  placeholder="24"
                  className={cn(
                    "w-full rounded-[10px] border border-transparent bg-surface-2 py-2.5 px-3 text-[16px] text-text-main transition-all placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm",
                    durationError && "border-red-500/40 ring-1 ring-red-500 focus:ring-red-500/40"
                  )}
                />
                <Select
                  value={durationUnit}
                  onChange={(e) => setDurationUnit(e.target.value)}
                  options={DURATION_UNITS.map((u) => ({ value: u.value, label: u.label }))}
                  className="w-[140px] shrink-0"
                />
              </div>
              {durationError ? (
                <p className="flex items-center gap-1 text-xs text-red-500">
                  <span className="material-symbols-outlined text-[14px]">error</span>
                  {durationError}
                </p>
              ) : (
                <p className="text-xs text-text-muted">Counts down from the first request made with the key.</p>
              )}
            </div>
            <Input
              label="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What is this key for?"
            />
            <div className="flex gap-2">
              <Button onClick={createKey} fullWidth disabled={!canCreate} loading={saving} icon="add">
                Create
              </Button>
              <Button onClick={() => setCreateOpen(false)} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        confirmText="Delete"
        variant="danger"
        loading={confirmLoading}
      />
    </div>
  );
}

function SummaryCard({ icon, label, value }) {
  return (
    <Card padding="sm">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[22px]">{icon}</span>
        </div>
        <div className="min-w-0">
          <div className="truncate text-2xl font-bold leading-none text-text-main tabular-nums">{value}</div>
          <div className="mt-0.5 truncate text-xs text-text-muted">{label}</div>
        </div>
      </div>
    </Card>
  );
}

function TempKeyRow({ tempKey, onDelete, selected, onToggleSelect }) {
  const { copied, copy } = useCopyToClipboard(2000);
  const spentPct = tempKey.budgetUsd > 0
    ? Math.min(100, (Number(tempKey.spentUsd) / Number(tempKey.budgetUsd)) * 100)
    : 0;
  const remaining = timeLeft(tempKey.expiresAt);
  const statusLabel = tempKey.status.charAt(0).toUpperCase() + tempKey.status.slice(1);

  return (
    <div className={cn("group px-4 py-3 transition-colors hover:bg-surface-2/30", selected && "bg-surface-2/40")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(tempKey.id)}
            aria-label="Select temp key"
            className="h-4 w-4 shrink-0 rounded border-gray-300 text-primary focus:ring-primary"
          />
          <div className="flex min-w-0 flex-col gap-1">
            {tempKey.name && <span className="truncate text-sm font-medium text-text-main">{tempKey.name}</span>}
            <button
              type="button"
              onClick={() => copy(tempKey.key)}
              title="Copy key"
              className="flex w-fit max-w-full items-center gap-2 rounded-[8px] bg-surface-2 px-2.5 py-1.5 font-mono text-xs font-semibold text-text-main transition-colors hover:bg-surface-3"
            >
              <span className="truncate">{tempKey.key}</span>
              <span className="material-symbols-outlined shrink-0 text-[16px] text-text-muted">
                {copied ? "check" : "content_copy"}
              </span>
            </button>
            {tempKey.note && <span className="truncate text-xs text-text-muted">{tempKey.note}</span>}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 sm:justify-end">
          <div className="flex flex-col items-end gap-1">
            <span className="text-sm font-semibold text-text-main tabular-nums">
              {formatUsd(tempKey.spentUsd)} <span className="text-text-muted">/ {formatUsd(tempKey.budgetUsd)}</span>
            </span>
            <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-2">
              <div
                className={cn("h-full rounded-full", spentPct >= 100 ? "bg-red-500" : "bg-primary")}
                style={{ width: `${spentPct}%` }}
              />
            </div>
          </div>
          <span className={cn("rounded-full px-2 py-1 text-[11px] font-semibold", STATUS_STYLES[tempKey.status] || STATUS_STYLES.disabled)}>
            {statusLabel}
          </span>
          <button
            type="button"
            aria-label="Delete temp key"
            onClick={() => onDelete(tempKey)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/30"
          >
            <span className="material-symbols-outlined text-[20px]">delete</span>
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span className="flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">hourglass_empty</span>
          {formatDuration(tempKey.durationSeconds)} lifetime
        </span>
        {tempKey.firstUsedAt ? (
          <span>
            Started {formatDate(tempKey.firstUsedAt)}
            {remaining && tempKey.status === "active" && <span className="ml-1 text-text-main">· {remaining}</span>}
            {tempKey.status === "expired" && <span className="ml-1 text-amber-500">· expired {formatDate(tempKey.expiresAt)}</span>}
          </span>
        ) : (
          <span className="italic">Not used yet — clock not started</span>
        )}
        <span>{tempKey.requestCount} request{tempKey.requestCount === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}
