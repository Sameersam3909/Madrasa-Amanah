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
  baseURL: getBaseUrl()
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("madrasa_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const msg = error.response?.data?.message || "Session expired. Please sign in again.";
      localStorage.removeItem("madrasa_token");
      localStorage.removeItem("madrasa_user");
      window.dispatchEvent(new CustomEvent("auth:unauthorized", { detail: { message: msg } }));
    }
    return Promise.reject(error);
  }
);

export default api;
