/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: { extend: { colors: { madrasa: { 50: "#f0f5ec", 100: "#dce9dc", 600: "#2f7655", 700: "#245c43", 800: "#194633" } } } },
  plugins: []
};
