"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, ConfirmModal, Input, Modal, Skeleton, Toggle } from "@/shared/components";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { useNotificationStore } from "@/store/notificationStore";
import { cn } from "@/shared/utils/cn";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_TABLE_COLUMNS = "md:grid-cols-[minmax(0,1fr)_5.75rem_5.75rem_3.5rem_6rem_4rem] xl:grid-cols-[minmax(20rem,1fr)_6.25rem_6.25rem_4rem_6.5rem_4rem] 2xl:grid-cols-[minmax(32rem,1fr)_6.5rem_6.5rem_4.5rem_6.5rem_4rem]";
const ACTION_MENU_WIDTH = 176;

function formatUsd(value) {
  if (value === null || value === undefined) return "No limit";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(Number(value || 0));
}

function getUserState(user) {
  if (!user.configured) return { label: "No limit", tone: "default" };
  if (!user.isActive) return { label: "Disabled", tone: "danger" };
  if (user.remainingUsd !== null && user.remainingUsd <= 0) return { label: "Limit reached", tone: "warning" };
  return { label: "Active", tone: "success" };
}

function getProgress(user) {
  if (!user.configured || !user.budgetUsd) return 0;
  return Math.min(100, Math.round((user.spentUsd / user.budgetUsd) * 100));
}

function getProgressTone(user) {
  const progress = getProgress(user);
  if (!user.configured) return "bg-text-muted/25";
  if (!user.isActive || progress >= 100) return "bg-red-500";
  if (progress >= 80) return "bg-yellow-500";
  return "bg-brand-500";
}

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalState, setModalState] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [topUpState, setTopUpState] = useState(null);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [redeemState, setRedeemState] = useState(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [form, setForm] = useState({ email: "", budgetUsd: "", isActive: true });

  const notifySuccess = useNotificationStore((s) => s.success);
  const notifyError = useNotificationStore((s) => s.error);
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  useEffect(() => {
    registerSearch("Search users...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load users");
      setUsers(data.users || []);
    } catch (error) {
      notifyError(error.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const filteredUsers = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((user) => user.email.toLowerCase().includes(needle));
  }, [users, searchQuery]);

  const summary = useMemo(() => {
    return users.reduce((acc, user) => {
      acc.totalUsers += 1;
      if (user.configured) {
        acc.configured += 1;
        acc.totalBudget += Number(user.budgetUsd || 0);
      }
      if (user.isActive && user.configured) acc.active += 1;
      if (user.configured && user.remainingUsd !== null && user.remainingUsd <= 0) acc.limitReached += 1;
      acc.totalSpent += Number(user.spentUsd || 0);
      return acc;
    }, { totalUsers: 0, configured: 0, active: 0, limitReached: 0, totalBudget: 0, totalSpent: 0 });
  }, [users]);

  const openCreateModal = () => {
    setForm({ email: "", budgetUsd: "", isActive: true });
    setModalState({ mode: "create" });
  };

  const openEditModal = (user) => {
    setForm({
      email: user.email,
      budgetUsd: user.budgetUsd === null ? "" : String(user.budgetUsd),
      isActive: user.isActive !== false,
    });
    setModalState({ mode: "edit", user });
  };

  const closeModal = () => {
    setModalState(null);
    setForm({ email: "", budgetUsd: "", isActive: true });
  };

  const openTopUpModal = (user) => {
    setTopUpAmount("");
    setTopUpState(user);
  };

  const closeTopUpModal = () => {
    setTopUpState(null);
    setTopUpAmount("");
  };

  const openRedeemModal = (user) => {
    setRedeemCode("");
    setRedeemState(user);
  };

  const closeRedeemModal = () => {
    setRedeemState(null);
    setRedeemCode("");
  };

  const formEmail = form.email.trim().toLowerCase();
  const budgetValue = Number(form.budgetUsd);
  const emailError = form.email && !EMAIL_PATTERN.test(formEmail) ? "Enter a valid email address" : "";
  const budgetError = form.budgetUsd !== "" && (!Number.isFinite(budgetValue) || budgetValue < 0)
    ? "Budget must be zero or higher"
    : "";
  const canSave = EMAIL_PATTERN.test(formEmail) && form.budgetUsd !== "" && Number.isFinite(budgetValue) && budgetValue >= 0;
  const topUpValue = Number(topUpAmount);
  const topUpError = topUpAmount !== "" && (!Number.isFinite(topUpValue) || topUpValue <= 0)
    ? "Amount must be greater than zero"
    : "";
  const canTopUp = !!topUpState && topUpAmount !== "" && Number.isFinite(topUpValue) && topUpValue > 0;
  const canRedeem = !!redeemState && redeemCode.trim() !== "";

  const saveUser = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const isEdit = modalState?.mode === "edit";
      const url = isEdit ? `/api/users/${encodeURIComponent(formEmail)}` : "/api/users";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: formEmail,
          budgetUsd: budgetValue,
          isActive: form.isActive,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save user");
      notifySuccess(isEdit ? "User budget updated" : "User budget created");
      closeModal();
      await loadUsers();
    } catch (error) {
      notifyError(error.message || "Failed to save user");
    } finally {
      setSaving(false);
    }
  };

  const toggleUser = async (user, isActive) => {
    if (!user.configured) {
      openEditModal(user);
      return;
    }
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.email)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budgetUsd: user.budgetUsd, isActive }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update user");
      await loadUsers();
    } catch (error) {
      notifyError(error.message || "Failed to update user");
    }
  };

  const addUserBudget = async () => {
    if (!canTopUp || !topUpState) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(topUpState.email)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add-budget", amountUsd: topUpValue }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add budget");
      notifySuccess(`Added ${formatUsd(topUpValue)} to ${topUpState.email}`);
      closeTopUpModal();
      await loadUsers();
    } catch (error) {
      notifyError(error.message || "Failed to add budget");
    } finally {
      setSaving(false);
    }
  };

  const redeemVoucher = async () => {
    if (!canRedeem || !redeemState) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(redeemState.email)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "redeem-voucher", code: redeemCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to redeem voucher");
      notifySuccess(`Added ${formatUsd(data.voucher?.amountUsd || 0)} to ${redeemState.email}`);
      closeRedeemModal();
      await loadUsers();
    } catch (error) {
      notifyError(error.message || "Failed to redeem voucher");
    } finally {
      setSaving(false);
    }
  };

  const resetUserUsage = (user) => {
    setConfirmState({
      title: "Reset User Usage",
      message: `Reset recorded usage for ${user.email}? The budget limit stays ${formatUsd(user.budgetUsd)}.`,
      confirmText: "Reset Usage",
      onConfirm: async () => {
        setConfirmLoading(true);
        try {
          const res = await fetch(`/api/users/${encodeURIComponent(user.email)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "reset-usage" }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to reset usage");
          notifySuccess("User usage reset");
          setConfirmState(null);
          await loadUsers();
        } catch (error) {
          notifyError(error.message || "Failed to reset usage");
        } finally {
          setConfirmLoading(false);
        }
      },
    });
  };

  const removeUserLimit = (user) => {
    setConfirmState({
      title: "Remove User Budget",
      message: `Remove the budget limit for ${user.email}? API keys assigned to this user will not be budget-limited.`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/users/${encodeURIComponent(user.email)}`, { method: "DELETE" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to remove budget");
          notifySuccess("User budget removed");
          await loadUsers();
        } catch (error) {
          notifyError(error.message || "Failed to remove budget");
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
        <SummaryCard icon="group" label="Users" value={summary.totalUsers} />
        <SummaryCard icon="price_check" label="Configured" value={summary.configured} />
        <SummaryCard icon="account_balance_wallet" label="Budget" value={formatUsd(summary.totalBudget)} />
        <SummaryCard icon="payments" label="Used" value={formatUsd(summary.totalSpent)} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 rounded-[10px] border border-border-subtle bg-surface px-3 py-2.5">
          <span className="material-symbols-outlined shrink-0 text-[16px] text-primary">admin_panel_settings</span>
          <p className="text-xs text-text-muted">
            User budgets apply across every API key with the same email.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" icon="refresh" size="sm" onClick={loadUsers}>
            Refresh
          </Button>
          <Button icon="person_add" size="sm" onClick={openCreateModal}>
            Add User
          </Button>
        </div>
      </div>

      <Card padding="none" className="overflow-hidden">
        <div className={cn("hidden items-center gap-3 border-b border-border-subtle bg-surface-2/40 px-4 py-2 md:grid", USER_TABLE_COLUMNS)}>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">User</span>
          <span className="text-right text-[10px] font-semibold uppercase tracking-wider text-text-muted">Budget</span>
          <span className="text-right text-[10px] font-semibold uppercase tracking-wider text-text-muted">Used</span>
          <span className="text-right text-[10px] font-semibold uppercase tracking-wider text-text-muted">Keys</span>
          <span className="text-center text-[10px] font-semibold uppercase tracking-wider text-text-muted">Status</span>
          <span className="text-right text-[10px] font-semibold uppercase tracking-wider text-text-muted">Actions</span>
        </div>

        {filteredUsers.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <span className="material-symbols-outlined mb-3 block text-[40px] text-text-muted">group</span>
            <p className="text-sm font-medium text-text-main">No users found</p>
            <p className="mt-1 text-xs text-text-muted">Create a user budget to limit spend</p>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {filteredUsers.map((user) => (
              <UserRow
                key={user.email}
                user={user}
                onEdit={openEditModal}
                onTopUp={openTopUpModal}
                onRedeem={openRedeemModal}
                onResetUsage={resetUserUsage}
                onToggle={toggleUser}
                onRemove={removeUserLimit}
              />
            ))}
          </div>
        )}
      </Card>

      <Modal
        isOpen={!!modalState}
        title={modalState?.mode === "edit" ? "Edit User Budget" : "Add User"}
        onClose={closeModal}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="User Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
            placeholder="user@example.com"
            error={emailError}
            disabled={modalState?.mode === "edit"}
            required
          />
          <BudgetInput
            value={form.budgetUsd}
            onChange={(value) => setForm((prev) => ({ ...prev, budgetUsd: value }))}
            error={budgetError}
          />
          <div className="flex items-center justify-between rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-main">Active</p>
              <p className="text-xs text-text-muted">Allow this user to use their budget</p>
            </div>
            <Toggle
              checked={form.isActive}
              onChange={(checked) => setForm((prev) => ({ ...prev, isActive: checked }))}
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={saveUser} fullWidth disabled={!canSave} loading={saving}>
              Save
            </Button>
            <Button onClick={closeModal} variant="ghost" fullWidth>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={!!topUpState}
        title="Add User Budget"
        onClose={closeTopUpModal}
      >
        <div className="flex flex-col gap-4">
          {topUpState && (
            <div className="grid grid-cols-3 gap-2 rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-2.5">
              <BudgetPreview label="Current" value={formatUsd(topUpState.budgetUsd)} />
              <BudgetPreview label="Used" value={formatUsd(topUpState.spentUsd)} />
              <BudgetPreview label="After" value={formatUsd(Number(topUpState.budgetUsd || 0) + (canTopUp ? topUpValue : 0))} />
            </div>
          )}
          <BudgetInput
            label="Amount to add"
            value={topUpAmount}
            onChange={setTopUpAmount}
            error={topUpError}
            placeholder="10.00"
          />
          <div className="flex gap-2">
            <Button onClick={addUserBudget} fullWidth disabled={!canTopUp} loading={saving} icon="add_card">
              Add Budget
            </Button>
            <Button onClick={closeTopUpModal} variant="ghost" fullWidth>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={!!redeemState}
        title="Redeem Voucher"
        onClose={closeRedeemModal}
      >
        <div className="flex flex-col gap-4">
          {redeemState && (
            <p className="text-sm text-text-muted">
              Redeem a voucher code to add its value to{" "}
              <span className="font-medium text-text-main">{redeemState.email}</span>.
            </p>
          )}
          <Input
            label="Voucher Code"
            value={redeemCode}
            onChange={(e) => setRedeemCode(e.target.value)}
            placeholder="V-XXXX-XXXX-XXXX"
            required
          />
          <div className="flex gap-2">
            <Button onClick={redeemVoucher} fullWidth disabled={!canRedeem} loading={saving} icon="redeem">
              Redeem
            </Button>
            <Button onClick={closeRedeemModal} variant="ghost" fullWidth>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText || "Confirm"}
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

function UserRow({ user, onEdit, onTopUp, onRedeem, onResetUsage, onToggle, onRemove }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const state = getUserState(user);
  const progress = getProgress(user);
  const hasUsage = Number(user.spentUsd || 0) > 0;
  const statusClasses = {
    default: "bg-surface-2 text-text-muted",
    success: "bg-green-500/10 text-green-600 dark:text-green-400",
    warning: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
  };
  const actionItems = [
    {
      label: user.configured ? "Edit budget" : "Set budget",
      onSelect: () => onEdit(user),
    },
    {
      label: "Add budget",
      disabled: !user.configured,
      onSelect: () => onTopUp(user),
    },
    {
      label: "Redeem voucher",
      disabled: !user.configured,
      onSelect: () => onRedeem(user),
    },
    {
      label: "Reset usage",
      disabled: !user.configured || !hasUsage,
      onSelect: () => onResetUsage(user),
    },
    user.configured && {
      label: user.isActive ? "Disable user" : "Enable user",
      onSelect: () => onToggle(user, !user.isActive),
    },
    {
      label: "Remove budget",
      disabled: !user.configured,
      tone: "danger",
      onSelect: () => onRemove(user),
    },
  ].filter(Boolean);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const closeFromOutside = (event) => {
      if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    const closeMenu = () => setMenuOpen(false);
    const closeFromKey = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("mousedown", closeFromOutside);
    document.addEventListener("keydown", closeFromKey);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);

    return () => {
      document.removeEventListener("mousedown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKey);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [menuOpen]);

  const toggleMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const menuHeight = actionItems.length * 32 + 8;
      setMenuPosition({
        top: Math.max(8, Math.min(rect.top, window.innerHeight - menuHeight - 8)),
        left: Math.max(8, rect.left - ACTION_MENU_WIDTH - 8),
      });
    }
    setMenuOpen((open) => !open);
  };

  const runMenuAction = (item) => {
    if (item.disabled) return;
    setMenuOpen(false);
    item.onSelect();
  };

  return (
    <div className="group px-4 py-3 transition-colors hover:bg-surface-2/30">
      <div className={cn("grid gap-3 md:items-center", USER_TABLE_COLUMNS)}>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="material-symbols-outlined shrink-0 text-[18px] text-text-muted">person</span>
            <span className="truncate text-sm font-semibold text-text-main">{user.email}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className={`h-full rounded-full ${getProgressTone(user)}`} style={{ width: `${progress}%` }} />
          </div>
        </div>

        <Metric label="Budget" value={formatUsd(user.budgetUsd)} />
        <Metric label="Used" value={formatUsd(user.spentUsd)} />
        <Metric label="Keys" value={user.keyCount} />

        <div className="flex items-center justify-between gap-2 md:justify-center">
          <span className="md:hidden text-xs text-text-muted">Status</span>
          <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${statusClasses[state.tone]}`}>
            {state.label}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 md:justify-end">
          <span className="text-xs text-text-muted md:hidden">Actions</span>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`Open actions for ${user.email}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={toggleMenu}
            className={cn(
              "inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-text-muted transition-colors",
              "hover:bg-surface-3 hover:text-primary focus:outline-none focus:ring-2 focus:ring-brand-500/30",
              menuOpen && "bg-surface-3 text-primary"
            )}
          >
            <span className="material-symbols-outlined text-[20px]">more_vert</span>
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              role="menu"
              style={{ top: `${menuPosition.top}px`, left: `${menuPosition.left}px`, width: `${ACTION_MENU_WIDTH}px` }}
              className="fixed z-50 rounded-[10px] border border-border-subtle bg-surface py-1 shadow-[var(--shadow-elev)]"
            >
              {actionItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => runMenuAction(item)}
                  className={cn(
                    "block w-full px-3 py-2 text-left text-xs font-semibold text-text-main transition-colors",
                    "hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-text-muted/45 disabled:hover:bg-transparent",
                    item.tone === "danger" && "text-red-500 hover:bg-red-500/10"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 md:block md:text-right">
      <span className="text-xs text-text-muted md:hidden">{label}</span>
      <span className="text-sm font-medium text-text-main tabular-nums md:text-xs md:font-semibold">
        {value}
      </span>
    </div>
  );
}

function BudgetPreview({ label, value }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] font-semibold uppercase text-text-muted">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-text-main tabular-nums">{value}</p>
    </div>
  );
}

function BudgetInput({ label = "Budget", value, onChange, error, placeholder = "25.00", step = "1" }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text-main">
        {label} <span className="text-red-500 ml-1">*</span>
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-text-muted">$</span>
        <input
          type="number"
          min="0"
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`w-full rounded-[10px] border border-transparent bg-surface-2 py-2.5 pl-7 pr-3 text-[16px] text-text-main transition-all placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm ${error ? "ring-1 ring-red-500 focus:ring-red-500/40 border-red-500/40" : ""}`}
        />
      </div>
      {error && (
        <p className="flex items-center gap-1 text-xs text-red-500">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
    </div>
  );
}
