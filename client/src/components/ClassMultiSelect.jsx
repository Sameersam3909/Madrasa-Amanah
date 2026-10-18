import React, { useState, useRef, useEffect, useMemo } from "react";
import { Check, X, Search, ChevronDown, BookOpen } from "lucide-react";

/**
 * ClassMultiSelect
 * Searchable multi-select component for student class assignments.
 * Supports chips/tags, Select All / Clear All, responsive layout,
 * and localization (English, Urdu, Telugu).
 */
export default function ClassMultiSelect({
  classes = [],
  selectedClassIds = [],
  onChange,
  lang = "en",
  disabled = false,
  error = "",
  label = "Assigned Classes",
  required = true
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const containerRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, []);

  const formatClassLabel = (cls) => {
    if (!cls) return "";
    const name = cls.name || "Class";
    const section = cls.section ? ` (${cls.section})` : "";
    const year = cls.academicYear ? ` · ${cls.academicYear}` : "";
    return `${name}${section}${year}`;
  };

  const filteredClasses = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return classes;
    return classes.filter((c) => {
      const full = `${c.name || ""} ${c.section || ""} ${c.academicYear || ""}`.toLowerCase();
      return full.includes(term);
    });
  }, [classes, searchTerm]);

  const selectedSet = useMemo(() => {
    return new Set((selectedClassIds || []).map((id) => String(id?._id || id?.id || id)));
  }, [selectedClassIds]);

  const selectedClassesList = useMemo(() => {
    return (selectedClassIds || [])
      .map((id) => {
        const strId = String(id?._id || id?.id || id);
        return classes.find((c) => String(c._id || c.id) === strId) || (typeof id === "object" ? id : { _id: strId, name: "Class" });
      })
      .filter(Boolean);
  }, [classes, selectedClassIds]);

  const toggleClass = (classId) => {
    if (disabled) return;
    const strId = String(classId);
    let updated;
    if (selectedSet.has(strId)) {
      updated = Array.from(selectedSet).filter((id) => id !== strId);
    } else {
      updated = [...Array.from(selectedSet), strId];
    }
    onChange?.(updated);
  };

  const removeClass = (e, classId) => {
    e.stopPropagation();
    if (disabled) return;
    const strId = String(classId);
    const updated = Array.from(selectedSet).filter((id) => id !== strId);
    onChange?.(updated);
  };

  const handleSelectAll = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    const allIds = classes.map((c) => String(c._id || c.id));
    onChange?.(allIds);
  };

  const handleClearAll = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    onChange?.([]);
  };

  const isRTL = lang === "ur";

  return (
    <div
      ref={containerRef}
      className="class-multiselect-container"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        position: "relative",
        width: "100%",
        direction: isRTL ? "rtl" : "ltr"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {label} {required && <span style={{ color: "var(--danger)" }}>*</span>}
        </span>
        {classes.length > 1 && !disabled && (
          <div style={{ display: "flex", gap: 10, fontSize: 11 }}>
            <button
              type="button"
              onClick={handleSelectAll}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--primary)",
                fontWeight: 600,
                cursor: "pointer",
                padding: "2px 4px"
              }}
            >
              {lang === "ur" ? "سب منتخب کریں" : lang === "te" ? "అన్నీ ఎంచుకోండి" : "Select All"}
            </button>
            <span style={{ color: "var(--border)" }}>|</span>
            <button
              type="button"
              onClick={handleClearAll}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--muted)",
                cursor: "pointer",
                padding: "2px 4px"
              }}
            >
              {lang === "ur" ? "صاف کریں" : lang === "te" ? "అన్నీ తొలగించు" : "Clear All"}
            </button>
          </div>
        )}
      </div>

      {/* Selected Chips Box */}
      <div
        onClick={() => !disabled && setIsOpen(!isOpen)}
        style={{
          minHeight: 44,
          padding: "6px 10px",
          background: disabled ? "var(--bg-subtle, #F3F4F6)" : "var(--surface, #FFFFFF)",
          border: error ? "1.5px solid var(--danger, #EF4444)" : isOpen ? "1.5px solid var(--primary, #174B36)" : "1px solid var(--border, #E5E7EB)",
          borderRadius: 10,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          cursor: disabled ? "not-allowed" : "pointer",
          transition: "border-color 0.15s ease",
          boxShadow: isOpen ? "0 0 0 3px rgba(23, 75, 54, 0.1)" : "none"
        }}
      >
        {selectedClassesList.length > 0 ? (
          selectedClassesList.map((cls) => {
            const cId = String(cls._id || cls.id);
            return (
              <span
                key={cId}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 8px 4px 10px",
                  borderRadius: 16,
                  background: "var(--primary-subtle, #E8F5E9)",
                  color: "var(--primary, #174B36)",
                  fontSize: 12,
                  fontWeight: 600,
                  border: "1px solid rgba(23, 75, 54, 0.18)",
                  maxWidth: "100%",
                  lineHeight: 1.2
                }}
              >
                <BookOpen size={13} style={{ flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {formatClassLabel(cls)}
                </span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={(e) => removeClass(e, cId)}
                    style={{
                      background: "rgba(23, 75, 54, 0.12)",
                      border: "none",
                      borderRadius: "50%",
                      width: 16,
                      height: 16,
                      display: "grid",
                      placeItems: "center",
                      cursor: "pointer",
                      padding: 0,
                      color: "var(--primary)",
                      marginLeft: 2
                    }}
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                )}
              </span>
            );
          })
        ) : (
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            {lang === "ur" ? "کلاس منتخب کریں..." : lang === "te" ? "తరగతిని ఎంచుకోండి..." : "Select one or more classes..."}
          </span>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, color: "var(--muted)" }}>
          <ChevronDown size={18} style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </div>
      </div>

      {/* Dropdown Options */}
      {isOpen && !disabled && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 150,
            background: "var(--surface, #FFFFFF)",
            border: "1px solid var(--border, #E5E7EB)",
            borderRadius: 12,
            marginTop: 4,
            boxShadow: "0 10px 25px rgba(0, 0, 0, 0.15)",
            maxHeight: 280,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
          }}
        >
          {/* Search Bar */}
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
            <Search size={15} color="var(--muted)" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={lang === "ur" ? "کلاس تلاش کریں..." : lang === "te" ? "తరగతి శోధించండి..." : "Search classes..."}
              autoFocus
              style={{
                width: "100%",
                border: "none",
                outline: "none",
                fontSize: 13,
                background: "transparent"
              }}
              onClick={(e) => e.stopPropagation()}
            />
            {searchTerm && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSearchTerm("");
                }}
                style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 2 }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Options List */}
          <div style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}>
            {filteredClasses.length > 0 ? (
              filteredClasses.map((c) => {
                const cId = String(c._id || c.id);
                const isSelected = selectedSet.has(cId);
                return (
                  <div
                    key={cId}
                    onClick={() => toggleClass(cId)}
                    style={{
                      padding: "8px 14px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      cursor: "pointer",
                      background: isSelected ? "var(--primary-subtle, #F0FDF4)" : "transparent",
                      color: isSelected ? "var(--primary, #174B36)" : "var(--text)",
                      fontSize: 13,
                      transition: "background-color 0.1s"
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "var(--bg-subtle, #F9FAFB)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <div
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 4,
                          border: isSelected ? "1.5px solid var(--primary)" : "1.5px solid var(--border)",
                          background: isSelected ? "var(--primary)" : "#fff",
                          display: "grid",
                          placeItems: "center",
                          color: "#fff",
                          flexShrink: 0
                        }}
                      >
                        {isSelected && <Check size={13} strokeWidth={3} />}
                      </div>
                      <span style={{ fontWeight: isSelected ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {formatClassLabel(c)}
                      </span>
                    </div>
                    {c.academicYear && (
                      <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0 }}>
                        {c.academicYear}
                      </span>
                    )}
                  </div>
                );
              })
            ) : (
              <div style={{ padding: "16px 12px", textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
                {lang === "ur" ? "کوئی کلاس نہیں ملی" : lang === "te" ? "తరగతులు కనుగొనబడలేదు" : "No classes found"}
              </div>
            )}
          </div>

          {/* Footer showing count */}
          <div style={{ padding: "6px 12px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--muted)", display: "flex", justifyContent: "space-between", background: "var(--bg-subtle, #FAFAFA)" }}>
            <span>
              {selectedSet.size} {lang === "ur" ? "منتخب" : lang === "te" ? "ఎంచుకోబడింది" : "selected"}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsOpen(false);
              }}
              style={{ background: "transparent", border: "none", color: "var(--primary)", fontWeight: 600, cursor: "pointer", fontSize: 11 }}
            >
              {lang === "ur" ? "ہو گیا" : lang === "te" ? "పూర్తయింది" : "Done"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <span style={{ color: "var(--danger)", fontSize: 11, fontWeight: 500 }}>
          {error}
        </span>
      )}
    </div>
  );
}
