import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated/vendorized assets.
    "public/libraw-wasm/**",
  ]),
  {
    files: ["scripts/**/*.js", "src/lib/pipeline/decodeNode.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["app/api/train/openai-tools/route.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "prefer-const": "off",
    },
  },
  {
    files: [
      "src/lib/pipeline/stages/match.ts",
      "src/lib/pipeline/stages/postModel2Grading.ts",
    ],
    rules: {
      "prefer-const": "off",
    },
  },
]);

export default eslintConfig;
