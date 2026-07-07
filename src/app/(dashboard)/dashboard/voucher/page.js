"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, ConfirmModal, Input, Modal, SegmentedControl, Select, Skeleton } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/utils/cn";

const VOUCHERS_PER_PAGE = 10;

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "redeemed", label: "Redeemed" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "amountHigh", label: "Amount: high to low" },
  { value: "amountLow", label: "Amount: low to high" },
];

export default function VoucherPage() {
  const [vouchers, setVouchers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [createdCodes, setCreatedCodes] = useState([]);
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
    registerSearch("Search vouchers...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  const loadVouchers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/voucher", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load vouchers");
      setVouchers(data.vouchers || []);
    } catch (error) {
      notifyError(error.message || "Failed to load vouchers");
    } finally {
      setLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    loadVouchers();
  }, [loadVouchers]);

  const filteredVouchers = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    let list = vouchers;
    if (needle) {
      list = list.filter((v) =>
        v.code.toLowerCase().includes(needle) ||
        (v.note || "").toLowerCase().includes(needle) ||
        (v.redeemedBy || "").toLowerCase().includes(needle)
      );
    }
    if (statusFilter === "active") {
      list = list.filter((v) => v.status !== "redeemed");
    } else if (statusFilter === "redeemed") {
      list = list.filter((v) => v.status === "redeemed");
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case "oldest":
          return new Date(a.createdAt) - new Date(b.createdAt);
        case "amountHigh":
          return Number(b.amountUsd) - Number(a.amountUsd);
        case "amountLow":
          return Number(a.amountUsd) - Number(b.amountUsd);
        case "newest":
        default:
          return new Date(b.createdAt) - new Date(a.createdAt);
      }
    });
    return sorted;
  }, [vouchers, searchQuery, statusFilter, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filteredVouchers.length / VOUCHERS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * VOUCHERS_PER_PAGE;
  const pagedVouchers = filteredVouchers.slice(pageStart, pageStart + VOUCHERS_PER_PAGE);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, statusFilter, sortBy]);

  const summary = useMemo(() => {
    return vouchers.reduce((acc, v) => {
      acc.total += 1;
      if (v.status === "redeemed") acc.redeemed += 1;
      else {
        acc.active += 1;
        acc.activeValue += Number(v.amountUsd || 0);
      }
      return acc;
    }, { total: 0, active: 0, redeemed: 0, activeValue: 0 });
  }, [vouchers]);

  const amountValue = Number(amount);
  const amountError = amount !== "" && (!Number.isFinite(amountValue) || amountValue <= 0)
    ? "Amount must be greater than zero"
    : "";
  const quantityValue = Math.floor(Number(quantity));
  const quantityError = quantity !== "" && (!Number.isFinite(quantityValue) || quantityValue < 1 || quantityValue > 100)
    ? "Quantity must be between 1 and 100"
    : "";
  const canCreate =
    amount !== "" && Number.isFinite(amountValue) && amountValue > 0 &&
    quantity !== "" && Number.isFinite(quantityValue) && quantityValue >= 1 && quantityValue <= 100;

  const openCreate = () => {
    setAmount("");
    setQuantity("1");
    setNote("");
    setCreatedCodes([]);
    setCreateOpen(true);
  };

  const createVoucher = async () => {
    if (!canCreate) return;
    setSaving(true);
    try {
      const res = await fetch("/api/voucher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountUsd: amountValue,
          count: quantityValue,
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create voucher");
      const created = data.vouchers || [];
      notifySuccess(created.length === 1 ? `Voucher ${created[0].code} created` : `${created.length} vouchers created`);
      setCreatedCodes(created.map((v) => v.code));
      await loadVouchers();
    } catch (error) {
      notifyError(error.message || "Failed to create voucher");
    } finally {
      setSaving(false);
    }
  };

  const deleteVoucher = (voucher) => {
    setConfirmState({
      title: "Delete Voucher",
      message: `Delete voucher ${voucher.code}? This cannot be undone.`,
      onConfirm: async () => {
        setConfirmLoading(true);
        try {
          const res = await fetch(`/api/voucher/${voucher.id}`, { method: "DELETE" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to delete voucher");
          notifySuccess("Voucher deleted");
          setConfirmState(null);
          await loadVouchers();
        } catch (error) {
          notifyError(error.message || "Failed to delete voucher");
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

  const visibleIds = useMemo(() => pagedVouchers.map((v) => v.id), [pagedVouchers]);
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const bulkDelete = () => {
    const ids = visibleIds.filter((id) => selectedIds.has(id));
    if (ids.length === 0) return;
    setConfirmState({
      title: "Delete Vouchers",
      message: `Delete ${ids.length} selected voucher${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
      onConfirm: async () => {
        setConfirmLoading(true);
        try {
          const res = await fetch("/api/voucher", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to delete vouchers");
          notifySuccess(`${data.deleted} voucher${data.deleted === 1 ? "" : "s"} deleted`);
          setConfirmState(null);
          setSelectedIds(new Set());
          await loadVouchers();
        } catch (error) {
          notifyError(error.message || "Failed to delete vouchers");
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
        <SummaryCard icon="confirmation_number" label="Vouchers" value={summary.total} />
        <SummaryCard icon="check_circle" label="Active" value={summary.active} />
        <SummaryCard icon="redeem" label="Redeemed" value={summary.redeemed} />
        <SummaryCard icon="account_balance_wallet" label="Active Value" value={formatUsd(summary.activeValue)} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 rounded-[10px] border border-border-subtle bg-surface px-3 py-2.5">
          <span className="material-symbols-outlined shrink-0 text-[16px] text-primary">info</span>
          <p className="text-xs text-text-muted">
            Redeem a voucher from the Users page to add its value to a user&apos;s budget.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" icon="refresh" size="sm" onClick={loadVouchers}>
            Refresh
          </Button>
          <Button icon="add" size="sm" onClick={openCreate}>
            Create Voucher
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
        {filteredVouchers.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <span className="material-symbols-outlined mb-3 block text-[40px] text-text-muted">confirmation_number</span>
            <p className="text-sm font-medium text-text-main">No vouchers found</p>
            <p className="mt-1 text-xs text-text-muted">Create a voucher to hand out budget</p>
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
              {pagedVouchers.map((voucher) => (
                <VoucherRow
                  key={voucher.id}
                  voucher={voucher}
                  onDelete={deleteVoucher}
                  selected={selectedIds.has(voucher.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      <Pagination
        currentPage={safePage}
        pageSize={VOUCHERS_PER_PAGE}
        totalItems={filteredVouchers.length}
        onPageChange={setPage}
      />

      <Modal isOpen={createOpen} title="Create Voucher" onClose={() => setCreateOpen(false)}>
        {createdCodes.length > 0 ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 rounded-[10px] border border-green-500/30 bg-green-500/10 px-3 py-2.5">
              <span className="material-symbols-outlined shrink-0 text-[18px] text-green-500">check_circle</span>
              <p className="text-sm text-text-main">
                {createdCodes.length === 1 ? "1 voucher created" : `${createdCodes.length} vouchers created`}
              </p>
            </div>
            <textarea
              readOnly
              value={createdCodes.join("\n")}
              rows={Math.min(createdCodes.length, 10)}
              onFocus={(e) => e.target.select()}
              className="w-full resize-none rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-sm text-text-main focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
            <div className="flex gap-2">
              <Button
                onClick={() => copy(createdCodes.join("\n"), "bulk")}
                fullWidth
                icon={copied === "bulk" ? "check" : "content_copy"}
              >
                {copied === "bulk" ? "Copied" : "Copy all codes"}
              </Button>
              <Button onClick={() => setCreateOpen(false)} variant="ghost" fullWidth>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-main">
                Amount <span className="ml-1 text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-text-muted">$</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="10.00"
                  className={cn(
                    "w-full rounded-[10px] border border-transparent bg-surface-2 py-2.5 pl-7 pr-3 text-[16px] text-text-main transition-all placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm",
                    amountError && "border-red-500/40 ring-1 ring-red-500 focus:ring-red-500/40"
                  )}
                />
              </div>
              {amountError && (
                <p className="flex items-center gap-1 text-xs text-red-500">
                  <span className="material-symbols-outlined text-[14px]">error</span>
                  {amountError}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-main">
                Quantity <span className="ml-1 text-red-500">*</span>
              </label>
              <input
                type="number"
                min="1"
                max="100"
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="1"
                className={cn(
                  "w-full rounded-[10px] border border-transparent bg-surface-2 py-2.5 px-3 text-[16px] text-text-main transition-all placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm",
                  quantityError && "border-red-500/40 ring-1 ring-red-500 focus:ring-red-500/40"
                )}
              />
              {quantityError ? (
                <p className="flex items-center gap-1 text-xs text-red-500">
                  <span className="material-symbols-outlined text-[14px]">error</span>
                  {quantityError}
                </p>
              ) : (
                <p className="text-xs text-text-muted">Create up to 100 vouchers at once.</p>
              )}
            </div>
            <Input
              label="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Promo campaign, gift, etc."
            />
            <div className="flex gap-2">
              <Button onClick={createVoucher} fullWidth disabled={!canCreate} loading={saving} icon="add">
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

function VoucherRow({ voucher, onDelete, selected, onToggleSelect }) {
  const { copied, copy } = useCopyToClipboard(2000);
  const isRedeemed = voucher.status === "redeemed";

  return (
    <div className={cn("group px-4 py-3 transition-colors hover:bg-surface-2/30", selected && "bg-surface-2/40")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(voucher.id)}
            aria-label={`Select voucher ${voucher.code}`}
            className="h-4 w-4 shrink-0 rounded border-gray-300 text-primary focus:ring-primary"
          />
          <button
            type="button"
            onClick={() => copy(voucher.code)}
            title="Copy code"
            className="flex items-center gap-2 rounded-[8px] bg-surface-2 px-2.5 py-1.5 font-mono text-sm font-semibold text-text-main transition-colors hover:bg-surface-3"
          >
            {voucher.code}
            <span className="material-symbols-outlined text-[16px] text-text-muted">
              {copied ? "check" : "content_copy"}
            </span>
          </button>
          {voucher.note && (
            <span className="truncate text-xs text-text-muted">{voucher.note}</span>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 sm:justify-end">
          <span className="text-sm font-semibold text-text-main tabular-nums">{formatUsd(voucher.amountUsd)}</span>
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[11px] font-semibold",
              isRedeemed
                ? "bg-surface-2 text-text-muted"
                : "bg-green-500/10 text-green-600 dark:text-green-400"
            )}
          >
            {isRedeemed ? "Redeemed" : "Active"}
          </span>
          <button
            type="button"
            aria-label={`Delete voucher ${voucher.code}`}
            onClick={() => onDelete(voucher)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/30"
          >
            <span className="material-symbols-outlined text-[20px]">delete</span>
          </button>
        </div>
      </div>
      {isRedeemed && (
        <p className="mt-2 text-xs text-text-muted">
          Redeemed by <span className="font-medium text-text-main">{voucher.redeemedBy}</span> on {formatDate(voucher.redeemedAt)}
        </p>
      )}
    </div>
  );
}
