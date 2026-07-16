import js from "@eslint/js"

export default [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { structuredClone: "readonly" }
    },
    rules: { semi: ["error", "never"] }
  },
  { ignores: ["dist/**", "coverage/**"] }
]
