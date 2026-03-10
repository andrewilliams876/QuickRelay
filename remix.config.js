/** @type {import('@remix-run/dev').AppConfig} */
export default {
  ignoredRouteFiles: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
  serverDependenciesToBundle: ["ws"]
};
