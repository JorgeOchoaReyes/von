// Present so `expo lint` has a config to run against.
//
// Without one, `expo lint` tries to scaffold ESLint interactively on first run
// — which in CI means the repo's own `pnpm turbo lint` step hangs or fails, and
// every generated app is born with a red build. The config itself is Expo's
// default; the point is that it exists.
module.exports = {
  extends: "expo",
  ignorePatterns: ["/dist/*", "/.expo/*", "/node_modules/*"],
};
