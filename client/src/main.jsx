import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { applyLanguageToDocument } from "./i18n";
import "./styles.css";

// Immediate synchronous direction & language application before first render
const initialLang = localStorage.getItem("madrasa_lang") || "en";
applyLanguageToDocument(initialLang);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
