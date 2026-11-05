import { useEffect, useId, useRef, useState } from "react";

type SearchOption = { value: string; label: string };

export function CatalogSearchableOption({
  label,
  value,
  options,
  placeholder,
  emptyLabel,
  required = false,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: SearchOption[];
  placeholder: string;
  emptyLabel: string;
  required?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = options.find((option) => option.value === value);
  const filtered = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const active = filtered[activeIndex];

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const choose = (option: SearchOption | undefined) => {
    if (!option) return;
    onChange(option.value);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="catalogSearchSelect" ref={rootRef}>
      <input
        type="search"
        role="combobox"
        aria-label={`Search ${label}`}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && active ? `${listId}-${active.value}` : undefined
        }
        aria-required={required}
        aria-invalid={required && !value ? true : undefined}
        required={required}
        value={open ? query : (selected?.label ?? "")}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => {
          setQuery("");
          setActiveIndex(0);
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(0, index - 1));
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            choose(active);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setQuery("");
            setOpen(false);
          } else if (event.key === "Tab") {
            setOpen(false);
          }
        }}
      />
      {required && !value && !open && (
        <small className="catalogSearchHint">
          Choose an option to continue.
        </small>
      )}
      {open && (
        <div className="catalogSearchPopup">
          <ul id={listId} role="listbox" aria-label={`${label} options`}>
            {value && (
              <li
                id={`${listId}__empty`}
                role="option"
                aria-selected={!value}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange("");
                  setQuery("");
                  setOpen(false);
                }}
              >
                {emptyLabel}
              </li>
            )}
            {filtered.map((option, index) => (
              <li
                id={`${listId}-${option.value}`}
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                className={index === activeIndex ? "is-active" : undefined}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
              >
                {option.label}
              </li>
            ))}
          </ul>
          {!filtered.length && (
            <p role="status" className="catalogSearchNoResults">
              No matching {label.toLowerCase()}. Use the suggestion request
              below if the catalog option is missing.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
