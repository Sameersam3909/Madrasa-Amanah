import React, { useState, useRef, useEffect, useMemo } from "react";
import { Search, ChevronDown, Check, X, AlertCircle } from "lucide-react";
import { getStudentDisplayName, getStudentNameDir, matchesStudentSearch } from "../utils/studentName.js";

/**
 * Custom Searchable Student Selection Combobox for Madrasa Amanah
 * - Emerald (#174B36), Ivory, & Gold theme
 * - Accessible: Keyboard navigation (Arrow keys, Enter, Escape), ARIA roles
 * - Multi-lingual search: English, Urdu, Telugu name, ID / admission number
 * - RTL/LTR automatic alignment
 * - Duplicate candidate assignment conflict indicator
 * - Inside-card bounds without overflowing viewport
 */
export default function StudentSearchDropdown({
  students = [],
  value = "",
  onChange,
  currentFaceNo = null,
  assignedMap = {}, // map of { studentId: faceNo }
  placeholder = "Choose student",
  disabled = false,
  loading = false,
  lang = "en",
  t = {}
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  const listboxRef = useRef(null);

  const isRtl = lang === "ur";

  // Selected student object
  const selectedStudent = useMemo(() => {
    if (!value) return null;
    return students.find((s) => String(s._id || s.id) === String(value)) || null;
  }, [students, value]);

  // Filtered student list based on multi-script search query
  const filteredStudents = useMemo(() => {
    if (!students || !students.length) return [];
    if (!searchQuery.trim()) return students;
    return students.filter((s) => matchesStudentSearch(s, searchQuery));
  }, [students, searchQuery]);

  // Handle outside click & Escape
  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
        setSearchQuery("");
        setHighlightedIndex(-1);
      }
    }
    function handleKeyDown(e) {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
        setSearchQuery("");
        setHighlightedIndex(-1);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside, { passive: true });
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  // Focus search input when menu opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  // Keyboard navigation within listbox
  function handleTriggerKeyDown(e) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setIsOpen(true);
      setHighlightedIndex(0);
    }
  }

  function handleSearchKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev < filteredStudents.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < filteredStudents.length) {
        selectStudent(filteredStudents[highlightedIndex]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
      setSearchQuery("");
      setHighlightedIndex(-1);
    }
  }

  function selectStudent(student) {
    const sId = student ? student._id || student.id : "";
    onChange(sId);
    setIsOpen(false);
    setSearchQuery("");
    setHighlightedIndex(-1);
  }

  function clearSelection(e) {
    e.stopPropagation();
    onChange("");
    setSearchQuery("");
  }

  // Check if current value has duplicate assignment conflict
  const duplicateConflictFaceNo =
    value && assignedMap[value] && assignedMap[value] !== currentFaceNo
      ? assignedMap[value]
      : null;

  const displaySelectedName = selectedStudent
    ? getStudentDisplayName(selectedStudent, lang)
    : "";
  const selectedNameDir = getStudentNameDir(displaySelectedName, lang);

  return (
    <div
      ref={containerRef}
      className="student-search-dropdown-container"
      style={{
        position: "relative",
        width: "100%",
        boxSizing: "border-box"
      }}
    >
      {/* Trigger Button */}
      <button
        type="button"
        className={`student-search-trigger ${isOpen ? "open" : ""} ${duplicateConflictFaceNo ? "has-conflict" : ""}`}
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        style={{
          width: "100%",
          minHeight: 40,
          background: "var(--surface)",
          border: `1.5px solid ${duplicateConflictFaceNo ? "var(--danger, #DC2626)" : isOpen ? "var(--primary, #174B36)" : "var(--border, #D8D2C4)"}`,
          borderRadius: 8,
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 13,
          color: selectedStudent ? "var(--text)" : "var(--muted)",
          boxShadow: isOpen ? "0 0 0 3px rgba(23, 75, 54, 0.12)" : "none",
          transition: "border-color 0.15s ease, box-shadow 0.15s ease",
          direction: isRtl ? "rtl" : "ltr",
          boxSizing: "border-box",
          userSelect: "none"
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0
          }}
        >
          {loading ? (
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              {t.loading || "Loading students..."}
            </span>
          ) : selectedStudent ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span
                dir={selectedNameDir}
                style={{
                  fontWeight: 600,
                  color: "var(--text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
              >
                {displaySelectedName}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--muted)",
                  background: "var(--canvas, #FAF8F5)",
                  padding: "1px 6px",
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  flexShrink: 0
                }}
              >
                #{selectedStudent.admissionNo || selectedStudent.admissionNumber || ""}
              </span>
              {duplicateConflictFaceNo && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#DC2626",
                    background: "#FEE2E2",
                    padding: "1px 6px",
                    borderRadius: 4,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    flexShrink: 0
                  }}
                  title={`Assigned to Face #${duplicateConflictFaceNo}`}
                >
                  <AlertCircle size={11} /> Face #{duplicateConflictFaceNo}
                </span>
              )}
            </div>
          ) : (
            <span style={{ color: "var(--muted)", fontSize: 13 }}>
              {placeholder || t.chooseStudent || "Choose student"}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          {selectedStudent && !disabled && (
            <span
              role="button"
              tabIndex={0}
              onClick={clearSelection}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && clearSelection(e)}
              title={t.clear || "Clear selection"}
              style={{
                color: "var(--muted)",
                padding: 2,
                borderRadius: 4,
                display: "grid",
                placeItems: "center",
                cursor: "pointer"
              }}
            >
              <X size={14} />
            </span>
          )}
          <ChevronDown
            size={16}
            style={{
              color: "var(--muted)",
              transform: isOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.2s ease"
            }}
          />
        </div>
      </button>

      {/* Dropdown Menu Container */}
      {isOpen && (
        <div
          className="student-search-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            maxHeight: 280,
            background: "var(--surface)",
            border: "1.5px solid var(--border, #D8D2C4)",
            borderRadius: 8,
            boxShadow: "0 10px 25px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04)",
            zIndex: 150,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            boxSizing: "border-box",
            direction: isRtl ? "rtl" : "ltr"
          }}
        >
          {/* Search Box Header */}
          <div
            style={{
              padding: "8px 10px",
              borderBottom: "1px solid var(--border)",
              background: "var(--canvas, #FAF8F5)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0
            }}
          >
            <Search size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setHighlightedIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder={t.searchStudentsPlaceholder || "Search by name or ID..."}
              aria-label={t.searchStudentsPlaceholder || "Search students"}
              style={{
                border: "none",
                background: "transparent",
                outline: "none",
                width: "100%",
                fontSize: 12.5,
                color: "var(--text)",
                padding: "2px 0",
                direction: isRtl ? "rtl" : "ltr"
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{
                  background: "none",
                  border: "none",
                  padding: 2,
                  cursor: "pointer",
                  color: "var(--muted)",
                  display: "grid",
                  placeItems: "center"
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Options List */}
          <div
            ref={listboxRef}
            role="listbox"
            aria-label="Students"
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "4px 0",
              WebkitOverflowScrolling: "touch"
            }}
          >
            {filteredStudents.length === 0 ? (
              <div
                style={{
                  padding: "16px 12px",
                  textAlign: "center",
                  fontSize: 12,
                  color: "var(--muted)"
                }}
              >
                {searchQuery
                  ? t.noStudentsMatchQuery || `No students matching "${searchQuery}"`
                  : t.noStudentsAvailable || "No eligible students available"}
              </div>
            ) : (
              filteredStudents.map((s, idx) => {
                const sId = String(s._id || s.id);
                const isSelected = String(value) === sId;
                const isHighlighted = highlightedIndex === idx;
                const assignedToFace =
                  assignedMap[sId] && assignedMap[sId] !== currentFaceNo
                    ? assignedMap[sId]
                    : null;
                const sDisplayName = getStudentDisplayName(s, lang);
                const nameDir = getStudentNameDir(sDisplayName, lang);

                return (
                  <div
                    key={sId}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => selectStudent(s)}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    style={{
                      padding: "8px 12px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      cursor: "pointer",
                      background: isSelected
                        ? "rgba(23, 75, 54, 0.1)"
                        : isHighlighted
                        ? "var(--canvas, #FAF8F5)"
                        : "transparent",
                      borderInlineStart: isSelected
                        ? "3px solid var(--primary, #174B36)"
                        : "3px solid transparent",
                      transition: "background 0.1s ease",
                      fontSize: 12.5,
                      boxSizing: "border-box"
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                        flex: 1
                      }}
                    >
                      <div
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: "50%",
                          background: isSelected ? "var(--primary, #174B36)" : "var(--primary-subtle, #EAF5EE)",
                          color: isSelected ? "#fff" : "var(--primary, #174B36)",
                          display: "grid",
                          placeItems: "center",
                          fontSize: 11,
                          fontWeight: 700,
                          flexShrink: 0
                        }}
                      >
                        {(sDisplayName?.[0] || s.name?.[0] || "#").toUpperCase()}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          minWidth: 0,
                          flex: 1
                        }}
                      >
                        <span
                          dir={nameDir}
                          style={{
                            fontWeight: isSelected ? 700 : 500,
                            color: "var(--text)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap"
                          }}
                        >
                          {sDisplayName}
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--muted)"
                          }}
                        >
                          {s.admissionNo ? `#${s.admissionNo}` : ""}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      {assignedToFace && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: "#DC2626",
                            background: "#FEE2E2",
                            padding: "2px 6px",
                            borderRadius: 4,
                            whiteSpace: "nowrap"
                          }}
                        >
                          Face #{assignedToFace}
                        </span>
                      )}
                      {isSelected && (
                        <Check size={14} style={{ color: "var(--primary, #174B36)" }} />
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
