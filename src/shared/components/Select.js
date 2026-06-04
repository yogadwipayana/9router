"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";

const MENU_MAX_HEIGHT = 260;

export default function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder = "Select an option",
  error,
  hint,
  disabled = false,
  required = false,
  className,
  selectClassName,
  id,
  name,
  onBlur,
  onFocus,
  ...props
}) {
  const generatedId = useId();
  const controlId = id || generatedId;
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState({ top: 0, left: 0, width: 0 });

  const normalizedOptions = useMemo(() => (
    options.map((option) => {
      if (typeof option === "string") return { value: option, label: option };
      return option;
    })
  ), [options]);
  const selectedIndex = normalizedOptions.findIndex((option) => String(option.value) === String(value));
  const selectedOption = selectedIndex >= 0 ? normalizedOptions[selectedIndex] : null;

  const positionMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const estimatedHeight = Math.min(MENU_MAX_HEIGHT, (normalizedOptions.length * 38) + 8);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const top = spaceBelow >= estimatedHeight || rect.top < estimatedHeight + 12
      ? rect.bottom + 6
      : rect.top - estimatedHeight - 6;

    setMenuStyle({
      top: Math.max(8, top),
      left: rect.left,
      width: rect.width,
    });
  };

  const openMenu = () => {
    if (disabled) return;
    positionMenu();
    setOpen(true);
  };

  const closeMenu = () => setOpen(false);

  const emitChange = (nextValue) => {
    onChange?.({
      target: { value: nextValue, name },
      currentTarget: { value: nextValue, name },
    });
  };

  const selectOption = (option) => {
    if (option.disabled) return;
    emitChange(option.value);
    closeMenu();
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      closeMenu();
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeMenu();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [open]);

  const handleTriggerKeyDown = (event) => {
    if (disabled) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open ? closeMenu() : openMenu();
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openMenu();
      const next = normalizedOptions.find((option, index) => index > selectedIndex && !option.disabled)
        || normalizedOptions.find((option) => !option.disabled);
      if (next) selectOption(next);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openMenu();
      const previous = [...normalizedOptions].reverse().find((option, reverseIndex) => {
        const index = normalizedOptions.length - 1 - reverseIndex;
        return index < selectedIndex && !option.disabled;
      }) || [...normalizedOptions].reverse().find((option) => !option.disabled);
      if (previous) selectOption(previous);
    }
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={controlId} className="text-sm font-medium text-text-main">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        {name && <input type="hidden" name={name} value={value ?? ""} />}
        <button
          id={controlId}
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={`${controlId}-listbox`}
          aria-required={required}
          disabled={disabled}
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={handleTriggerKeyDown}
          onBlur={onBlur}
          onFocus={onFocus}
          className={cn(
            "flex min-h-10 w-full items-center justify-between gap-3 py-2.5 pl-3 pr-2 text-left text-sm",
            "rounded-[10px] border border-transparent bg-surface-2 text-text-main",
            "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
            "transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed",
            "text-[16px] sm:text-sm",
            open && "border-brand-500/40 ring-2 ring-brand-500/30",
            error && "ring-1 ring-red-500 focus:ring-2 focus:ring-red-500/40 border-red-500/40",
            selectClassName
          )}
          {...props}
        >
          <span className={cn("truncate", !selectedOption && "text-text-muted")}>
            {selectedOption?.label || placeholder}
          </span>
          <span
            className={cn(
              "material-symbols-outlined shrink-0 text-[20px] text-text-muted transition-transform",
              open && "rotate-180 text-primary"
            )}
          >
            expand_more
          </span>
        </button>
        {open && (
          <div
            ref={menuRef}
            id={`${controlId}-listbox`}
            role="listbox"
            style={{
              top: `${menuStyle.top}px`,
              left: `${menuStyle.left}px`,
              width: `${menuStyle.width}px`,
              maxHeight: `${MENU_MAX_HEIGHT}px`,
            }}
            className="fixed z-[70] overflow-y-auto rounded-[10px] border border-border-subtle bg-surface py-1 shadow-[var(--shadow-elev)] custom-scrollbar"
          >
            {normalizedOptions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-text-muted">{placeholder}</div>
            ) : (
              normalizedOptions.map((option) => {
                const selected = String(option.value) === String(value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={option.disabled}
                    onClick={() => selectOption(option)}
                    className={cn(
                      "block w-full px-3 py-2 text-left text-sm transition-colors",
                      "hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-text-muted/45 disabled:hover:bg-transparent",
                      selected ? "bg-primary/10 font-semibold text-primary" : "text-text-main"
                    )}
                  >
                    <span className="block truncate">{option.label}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-xs text-text-muted">{hint}</p>
      )}
    </div>
  );
}
