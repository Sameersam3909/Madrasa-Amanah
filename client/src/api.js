import axios from "axios";

function getBaseUrl() {
  const envUrl = (import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || "").trim();
  if (envUrl) {
    const clean = envUrl.replace(/\/+$/, "");
    return clean.endsWith("/api") ? clean : `${clean}/api`;
  }
  return import.meta.env.PROD ? "/api" : "http://localhost:4000/api";
}

const api = axios.create({
  baseURL: getBaseUrl(),
  timeout: 15000 // Sensible 15s timeout prevents hanging on sluggish network
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("madrasa_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  config.metadata = { startTime: Date.now() };
  return config;
});

api.interceptors.response.use(
  (response) => {
    if (response.config?.metadata?.startTime) {
      const duration = Date.now() - response.config.metadata.startTime;
      if (import.meta.env.DEV || localStorage.getItem("madrasa_debug") === "true") {
        console.log(`[PERF] ${response.config.method?.toUpperCase()} ${response.config.url} -> ${response.status} (${duration}ms)`);
      }
    }
    return response;
  },
  async (error) => {
    const config = error.config;

    // Retry transient network failures (cold-start recovery) once with 600ms backoff
    // Never retry 401, 403, 400 or non-idempotent operations
    const status = error.response?.status;
    const isTransient = !status || status === 502 || status === 503 || status === 504;
    const isAuthError = status === 401 || status === 403;

    if (isTransient && config && !config._retry && config.method?.toLowerCase() === "get") {
      config._retry = true;
      await new Promise((resolve) => setTimeout(resolve, 600));
      return api(config);
    }

    if (status === 401) {
      const msg = error.response?.data?.message || "Session expired. Please sign in again.";
      localStorage.removeItem("madrasa_token");
      localStorage.removeItem("madrasa_user");
      window.dispatchEvent(new CustomEvent("auth:unauthorized", { detail: { message: msg, code: error.response?.data?.code } }));
    }
    return Promise.reject(error);
  }
);

export default api;
