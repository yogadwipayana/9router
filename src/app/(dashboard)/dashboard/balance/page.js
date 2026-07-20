"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Input, Modal, SegmentedControl, Skeleton } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/utils/cn";

/**
 * SMS OTP balance, seen from the issuing side.
 *
 * The rupiah wallets themselves live in the portfolio app's database — this
 * router only issues the vouchers that fund them. So everything here is derived
 * from `vouchers` where kind = "sms": what has been sold, what has been claimed,
 * and by whom. A claimed voucher is money that reached a buyer's wallet; an
 * unclaimed one is a code still in the wild.
 */

const ROWS_PER_PAGE = 10;

const VIEW_OPTIONS = [
  { value: "buyers", label: "Buyers" },
  { value: "unclaimed", label: "Unclaimed codes" },
];

function formatIdr(value) {
  return `Rp${Math.round(Number(value || 0)).toLocaleString("id-ID")}`;
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default function BalancePage() {
  const [vouchers, setVouchers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("buyers");
  const [page, setPage] = useState(1);

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [createdCodes, setCreatedCodes] = useState([]);

  const { copied, copy } = useCopyToClipboard(2000);
  const notifySuccess = useNotificationStore((s) => s.success);
  const notifyError = useNotificationStore((s) => s.error);
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  useEffect(() => {
    registerSearch("Search buyers or codes...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  const loadVouchers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/voucher", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load balance data");
      setVouchers((data.vouchers || []).filter((v) => v.kind === "sms"));
    } catch (error) {
      notifyError(error.message || "Failed to load balance data");
    } finally {
      setLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    loadVouchers();
  }, [loadVouchers]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, view]);

  const summary = useMemo(() => {
    return vouchers.reduce(
      (acc, v) => {
        const value = Number(v.amountIdr || 0);
        acc.issued += value;
        if (v.status === "redeemed") {
          acc.claimed += value;
          acc.claimedCount += 1;
          if (v.redeemedBy) acc.buyers.add(v.redeemedBy);
        } else {
          acc.unclaimed += value;
          acc.unclaimedCount += 1;
        }
        return acc;
      },
      { issued: 0, claimed: 0, claimedCount: 0, unclaimed: 0, unclaimedCount: 0, buyers: new Set() }
    );
  }, [vouchers]);

  /** One row per buyer: how much of their wallet came from vouchers, and when. */
  const buyers = useMemo(() => {
    const byEmail = new Map();
    for (const v of vouchers) {
      if (v.status !== "redeemed" || !v.redeemedBy) continue;
      const row = byEmail.get(v.redeemedBy) || {
        email: v.redeemedBy,
        total: 0,
        count: 0,
        lastAt: null,
      };
      row.total += Number(v.amountIdr || 0);
      row.count += 1;
      if (!row.lastAt || new Date(v.redeemedAt) > new Date(row.lastAt)) {
        row.lastAt = v.redeemedAt;
      }
      byEmail.set(v.redeemedBy, row);
    }
    return [...byEmail.values()].sort((a, b) => b.total - a.total);
  }, [vouchers]);

  const unclaimed = useMemo(
    () =>
      vouchers
        .filter((v) => v.status !== "redeemed")
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [vouchers]
  );

  const rows = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (view === "buyers") {
      return needle
        ? buyers.filter((b) => b.email.toLowerCase().includes(needle))
        : buyers;
    }
    return needle
      ? unclaimed.filter(
          (v) =>
            v.code.toLowerCase().includes(needle) ||
            (v.note || "").toLowerCase().includes(needle)
        )
      : unclaimed;
  }, [view, buyers, unclaimed, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pagedRows = rows.slice((safePage - 1) * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE);

  /* ── Create ── */

  const amountValue = Number(amount);
  const amountError =
    amount !== "" && (!Number.isFinite(amountValue) || amountValue <= 0)
      ? "Amount must be greater than zero"
      : "";
  const quantityValue = Math.floor(Number(quantity));
  const quantityError =
    quantity !== "" &&
    (!Number.isFinite(quantityValue) || quantityValue < 1 || quantityValue > 100)
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

  const createVouchers = async () => {
    if (!canCreate) return;
    setSaving(true);
    try {
      const res = await fetch("/api/voucher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "sms",
          amountIdr: amountValue,
          count: quantityValue,
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create voucher");
      const created = data.vouchers || [];
      notifySuccess(
        created.length === 1
          ? `Voucher ${created[0].code} created`
          : `${created.length} vouchers created`
      );
      setCreatedCodes(created.map((v) => v.code));
      await loadVouchers();
    } catch (error) {
      notifyError(error.message || "Failed to create voucher");
    } finally {
      setSaving(false);
    }
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
        <SummaryCard icon="payments" label="Issued" value={formatIdr(summary.issued)} sub={`${vouchers.length} vouchers`} />
        <SummaryCard icon="account_balance_wallet" label="Claimed" value={formatIdr(summary.claimed)} sub={`${summary.claimedCount} redeemed`} />
        <SummaryCard icon="pending" label="Unclaimed" value={formatIdr(summary.unclaimed)} sub={`${summary.unclaimedCount} codes out`} />
        <SummaryCard icon="group" label="Buyers" value={summary.buyers.size} sub="wallets funded" />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 rounded-[10px] border border-border-subtle bg-surface px-3 py-2.5">
          <span className="material-symbols-outlined shrink-0 text-[16px] text-primary">info</span>
          <p className="text-xs text-text-muted">
            Wallets live in the portfolio app. Claimed vouchers are the balance that reached buyers.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" icon="refresh" size="sm" onClick={loadVouchers}>
            Refresh
          </Button>
          <Button icon="add" size="sm" onClick={openCreate}>
            Create SMS Voucher
          </Button>
        </div>
      </div>

      <SegmentedControl
        options={VIEW_OPTIONS}
        value={view}
        onChange={setView}
        size="sm"
        className="w-full sm:w-auto sm:self-start"
      />

      <Card padding="none" className="overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <span className="material-symbols-outlined mb-3 block text-[40px] text-text-muted">
              account_balance_wallet
            </span>
            <p className="text-sm font-medium text-text-main">
              {view === "buyers" ? "No balance claimed yet" : "No unclaimed codes"}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {view === "buyers"
                ? "Create an SMS voucher and hand the code to a buyer"
                : "Every SMS voucher issued so far has been redeemed"}
            </p>
          </div>
        ) : (
          <div className={cn("divide-y divide-border-subtle", totalPages > 1 && "md:min-h-[589px]")}>
            {view === "buyers"
              ? pagedRows.map((buyer) => <BuyerRow key={buyer.email} buyer={buyer} />)
              : pagedRows.map((voucher) => <UnclaimedRow key={voucher.id} voucher={voucher} />)}
          </div>
        )}
      </Card>

      <Pagination
        currentPage={safePage}
        pageSize={ROWS_PER_PAGE}
        totalItems={rows.length}
        onPageChange={setPage}
      />

      <Modal isOpen={createOpen} title="Create SMS Voucher" onClose={() => setCreateOpen(false)}>
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
                Amount (IDR) <span className="ml-1 text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-text-muted">Rp</span>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="50000"
                  className={cn(
                    "w-full rounded-[10px] border border-transparent bg-surface-2 py-2.5 pl-9 pr-3 text-[16px] text-text-main transition-all placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm",
                    amountError && "border-red-500/40 ring-1 ring-red-500 focus:ring-red-500/40"
                  )}
                />
              </div>
              {amountError ? (
                <p className="flex items-center gap-1 text-xs text-red-500">
                  <span className="material-symbols-outlined text-[14px]">error</span>
                  {amountError}
                </p>
              ) : (
                <p className="text-xs text-text-muted">Credited to the buyer&apos;s SMS wallet on redemption.</p>
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
                  "w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 text-[16px] text-text-main transition-all placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm",
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
              placeholder="Buyer name, order id, etc."
            />
            <div className="flex gap-2">
              <Button onClick={createVouchers} fullWidth disabled={!canCreate} loading={saving} icon="add">
                Create
              </Button>
              <Button onClick={() => setCreateOpen(false)} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function SummaryCard({ icon, label, value, sub }) {
  return (
    <Card padding="sm">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[22px]">{icon}</span>
        </div>
        <div className="min-w-0">
          <div className="truncate text-2xl font-bold leading-none text-text-main tabular-nums">{value}</div>
          <div className="mt-0.5 truncate text-xs text-text-muted">
            {label}
            {sub ? <span className="ml-1">· {sub}</span> : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

function BuyerRow({ buyer }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-surface-2/30 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text-main">{buyer.email}</p>
        <p className="mt-0.5 text-xs text-text-muted">
          {buyer.count} voucher{buyer.count === 1 ? "" : "s"} · last {formatDate(buyer.lastAt)}
        </p>
      </div>
      <span className="shrink-0 text-sm font-semibold text-text-main tabular-nums">
        {formatIdr(buyer.total)}
      </span>
    </div>
  );
}

function UnclaimedRow({ voucher }) {
  const { copied, copy } = useCopyToClipboard(2000);

  return (
    <div className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-surface-2/30 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
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
        {voucher.note && <span className="truncate text-xs text-text-muted">{voucher.note}</span>}
      </div>
      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <span className="text-xs text-text-muted">{formatDate(voucher.createdAt)}</span>
        <span className="text-sm font-semibold text-text-main tabular-nums">
          {formatIdr(voucher.amountIdr)}
        </span>
      </div>
    </div>
  );
}
