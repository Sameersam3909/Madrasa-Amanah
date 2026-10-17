import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { applyLanguageToDocument } from "./i18n";
import "./styles.css";

// Immediate synchronous direction & language application before first render
const initialLang = localStorage.getItem("madrasa_lang") || "en";
applyLanguageToDocument(initialLang);

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Madrasa App caught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#f8fafc",
          padding: 20,
          fontFamily: "system-ui, sans-serif"
        }}>
          <div style={{
            background: "#ffffff",
            padding: 32,
            borderRadius: 16,
            boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
            maxWidth: 440,
            width: "100%",
            textAlign: "center"
          }}>
            <h2 style={{ margin: "0 0 10px", color: "#1e293b", fontSize: 20 }}>Something went wrong</h2>
            <p style={{ margin: "0 0 20px", color: "#64748b", fontSize: 14 }}>
              The application encountered an unexpected issue. Please click below to reload.
            </p>
            <button
              onClick={() => {
                window.location.reload();
              }}
              style={{
                width: "100%",
                padding: "12px 20px",
                backgroundColor: "#059669",
                color: "#ffffff",
                border: "none",
                borderRadius: 8,
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer"
              }}
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
