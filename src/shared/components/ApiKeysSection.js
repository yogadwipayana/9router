"use client";

import { useEffect, useState } from "react";
import Button from "./Button";
import Card from "./Card";
import Input from "./Input";
import Modal, { ConfirmModal } from "./Modal";
import Select from "./Select";
import Toggle from "./Toggle";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

export default function ApiKeysSection() {
  const [keys, setKeys] = useState([]);
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [requireApiKey, setRequireApiKey] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyUserEmail, setNewKeyUserEmail] = useState("");
  const [createError, setCreateError] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [visibleKeys, setVisibleKeys] = useState(new Set());
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    fetchKeys();
    fetchUsers();
    loadRequireApiKey();
  }, []);

  const fetchKeys = async () => {
    try {
      const res = await fetch("/api/keys");
      const data = await res.json();
      if (res.ok) setKeys(data.keys || []);
    } catch (error) {
      console.log("Error fetching keys:", error);
    }
  };

  const loadRequireApiKey = async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (res.ok) setRequireApiKey(data.requireApiKey || false);
    } catch (error) {
      console.log("Error loading requireApiKey:", error);
    }
  };

  const fetchUsers = async () => {
    setUsersLoading(true);
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setUsers(data.users || []);
    } catch (error) {
      console.log("Error fetching users:", error);
    } finally {
      setUsersLoading(false);
    }
  };

  const openCreateModal = () => {
    setCreateError("");
    setShowAddModal(true);
    fetchUsers();
  };

  const closeCreateModal = () => {
    setShowAddModal(false);
    setNewKeyName("");
    setNewKeyUserEmail("");
    setCreateError("");
  };

  const handleRequireApiKey = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApiKey: value }),
      });
      if (res.ok) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const handleCreateKey = async () => {
    const userEmail = newKeyUserEmail.trim().toLowerCase();
    if (!newKeyName.trim() || !userEmail) return;

    try {
      setCreateError("");
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim(), userEmail }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKey(data.key);
        await fetchKeys();
        setNewKeyName("");
        setNewKeyUserEmail("");
        setShowAddModal(false);
      } else {
        setCreateError(data.error || "Failed to create key");
      }
    } catch (error) {
      console.log("Error creating key:", error);
      setCreateError(error.message || "Failed to create key");
    }
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys((prev) => prev.filter((key) => key.id !== id));
            setVisibleKeys((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        } catch (error) {
          console.log("Error deleting key:", error);
        }
      },
    });
  };

  const handleToggleKey = async (id, isActive) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setKeys((prev) => prev.map((key) => key.id === id ? { ...key, isActive } : key));
      }
    } catch (error) {
      console.log("Error toggling key:", error);
    }
  };

  const maskKey = (fullKey) => {
    if (!fullKey) return "";
    return fullKey.length > 8 ? `${fullKey.slice(0, 8)}...` : fullKey;
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const getKeyUser = (key) => key.userEmail || key.owner || "No user";
  const userOptions = users
    .filter((user) => user.configured)
    .map((user) => ({
      value: user.email,
      label: `${user.email}${user.isActive === false ? " (disabled)" : ""}`,
    }));
  const hasUsers = userOptions.length > 0;
  const canCreateKey = Boolean(newKeyName.trim()) && Boolean(newKeyUserEmail) && hasUsers;

  return (
    <>
      <Card id="require-api-key">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">vpn_key</span>
            API Keys
          </h2>
          <Button icon="add" onClick={openCreateModal}>
            Create Key
          </Button>
        </div>

        <div className="flex items-center justify-between pb-4 mb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Require API key</p>
            <p className="text-sm text-text-muted">
              Requests without a valid key will be rejected
            </p>
          </div>
          <Toggle
            checked={requireApiKey}
            onChange={() => handleRequireApiKey(!requireApiKey)}
          />
        </div>

        {keys.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">vpn_key</span>
            </div>
            <p className="text-text-main font-medium mb-1">No API keys yet</p>
            <p className="text-sm text-text-muted mb-4">Create your first API key to get started</p>
            <Button icon="add" onClick={openCreateModal}>
              Create Key
            </Button>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)_auto] items-center gap-3 pb-2 text-xs font-medium text-text-muted border-b border-black/[0.03] dark:border-white/[0.03]">
              <span>Key</span>
              <span>User</span>
              <span className="text-right">Actions</span>
            </div>
            {keys.map((key) => {
              const userEmail = getKeyUser(key);

              return (
                <div
                  key={key.id}
                  className={`group grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)_auto] items-center gap-3 py-3 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0 ${key.isActive === false ? "opacity-60" : ""}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{key.name}</p>
                    <div className="flex items-center gap-2 mt-1 min-w-0">
                      <code className="text-xs text-text-muted font-mono truncate">
                        {visibleKeys.has(key.id) ? key.key : maskKey(key.key)}
                      </code>
                      <button
                        onClick={() => toggleKeyVisibility(key.id)}
                        className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all shrink-0"
                        title={visibleKeys.has(key.id) ? "Hide key" : "Show key"}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                      <button
                        onClick={() => copy(key.key, key.id)}
                        className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all shrink-0"
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {copied === key.id ? "check" : "content_copy"}
                        </span>
                      </button>
                    </div>
                    <p className="text-xs text-text-muted mt-1">
                      Created {new Date(key.createdAt).toLocaleDateString()}
                    </p>
                    <p className="text-xs text-text-muted mt-1 sm:hidden">
                      User <span className="break-all">{userEmail}</span>
                    </p>
                    {key.isActive === false && (
                      <p className="text-xs text-orange-500 mt-1">Paused</p>
                    )}
                  </div>
                  <div className="hidden sm:block min-w-0">
                    <span
                      className="block text-xs text-text-muted truncate"
                      title={userEmail}
                    >
                      {userEmail}
                    </span>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Toggle
                      size="sm"
                      checked={key.isActive ?? true}
                      onChange={(checked) => {
                        if (key.isActive && !checked) {
                          setConfirmState({
                            title: "Pause API Key",
                            message: `Pause API key "${key.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
                            onConfirm: async () => {
                              setConfirmState(null);
                              handleToggleKey(key.id, checked);
                            },
                          });
                        } else {
                          handleToggleKey(key.id, checked);
                        }
                      }}
                      title={key.isActive ? "Pause key" : "Resume key"}
                    />
                    <button
                      onClick={() => handleDeleteKey(key.id)}
                      className="p-2 hover:bg-red-500/10 rounded text-red-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        onClose={() => {
          closeCreateModal();
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />
          <Select
            label="User"
            value={newKeyUserEmail}
            onChange={(e) => {
              setNewKeyUserEmail(e.target.value);
              setCreateError("");
            }}
            options={userOptions}
            placeholder={usersLoading ? "Loading users..." : hasUsers ? "Select user email" : "Create a user first"}
            error={createError}
            hint={hasUsers ? "Only emails created in User can receive API keys." : "Add a user before creating an API key."}
            disabled={usersLoading || !hasUsers}
            required
          />
          {!hasUsers && !usersLoading && (
            <Button variant="secondary" icon="group" onClick={() => { window.location.href = "/dashboard/users"; }}>
              Manage Users
            </Button>
          )}
          <div className="flex gap-2">
            <Button onClick={handleCreateKey} fullWidth disabled={!canCreateKey}>
              Create
            </Button>
            <Button
              onClick={closeCreateModal}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={!!createdKey}
        title="API Key Created"
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              This is the only time you will see this key. Store it securely.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </>
  );
}
