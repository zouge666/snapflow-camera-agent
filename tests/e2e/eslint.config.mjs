import webConfig from "../../apps/web/eslint.config.mjs";

const e2eConfig = [
  ...webConfig,
  {
    settings: {
      react: {
        version: "19.2",
      },
    },
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
];

export default e2eConfig;
