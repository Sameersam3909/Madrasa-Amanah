import React, { useEffect, useState } from "react";
import { Globe } from "lucide-react";

/**
 * GoogleTranslate Component
 * Dynamically loads the official Google Website Translator script and mounts
 * the simple inline language picker.
 *
 * Stored database records (student names, guardian names, phone numbers, admission numbers)
 * are protected from translation by attaching `className="notranslate" translate="no"` to those elements.
 */
export default function GoogleTranslate({ compact = false }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    function initGoogleTranslate() {
      try {
        const container = document.getElementById("google_translate_element");
        if (container && (!container.hasChildNodes() || container.children.length === 0)) {
          new window.google.translate.TranslateElement(
            {
              pageLanguage: "en",
              includedLanguages: "en,ur,te,hi,ar,bn,ta,mr,gu,kn,ml",
              layout: window.google.translate.TranslateElement.InlineLayout.SIMPLE,
              autoDisplay: false
            },
            "google_translate_element"
          );
        }
        setLoaded(true);
      } catch (e) {
        console.warn("Google Translate init warning:", e);
      }
    }

    // If Google Translate is already available on window, mount it
    if (window.google && window.google.translate && window.google.translate.TranslateElement) {
      initGoogleTranslate();
      return;
    }

    // Set callback on window
    window.googleTranslateElementInit = () => {
      initGoogleTranslate();
    };

    // If script already exists in document, do not re-add
    const existingScript = document.getElementById("google-translate-script");
    if (!existingScript) {
      const script = document.createElement("script");
      script.id = "google-translate-script";
      script.type = "text/javascript";
      script.src = "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
      script.async = true;
      script.onerror = () => {
        // Silently mark as unavailable when blocked by client ad-blocker or offline
        setLoadError(true);
      };
      document.body.appendChild(script);
    }

    // Intercept Google Translate telemetry network rejection if blocked by client extension
    const handleRejection = (e) => {
      if (e.reason?.message?.includes("translate.googleapis.com") || String(e.reason).includes("translate")) {
        e.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  if (loadError) return null;

  return (
    <div
      className={`google-translate-wrapper ${compact ? "compact" : ""}`}
      title="Google Translate (UI Translation)"
    >
      <div id="google_translate_element" className="google-translate-element" />
    </div>
  );
}
