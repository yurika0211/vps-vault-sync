# Dependency maintenance

Reviewed 2026-11-18. `package-lock.json` is the reproducible development dependency graph. Node support for the current ESLint tooling is declared in `package.json`; CI uses the latest Node 20 patch.

Updates include esbuild 0.28.2, eslint-plugin-obsidianmd 0.6.0, and compatible lockfile refreshes for Handlebars, js-yaml, fast-uri, browserslist and other tools. Root overrides keep brace-expansion 1.x at a patched 1.1.22+ and Obsidian declaration dependencies on moment 2.31.0+. eslint-plugin-n uses the named `Minimatch` API, so its minimatch 9 dependency is overridden with patched 11.0.9; lint execution validates that consumer. No Jest/ts-jest major downgrade or forced audit rewrite is used.

The only direct production npm dependency is qrcode-generator. Obsidian is external to the bundle; its npm package supplies development declarations. The application's exclude matcher is local code in `src/util.ts`; it does not import picomatch.

`npm audit` is not clean: the original graph reported 58 affected nodes; the updated graph reports 44 high nodes, all rooted in picomatch's repeated-extglob advisory. The production-only audit reports zero. Picomatch's advisory affects all currently published releases (latest 4.0.7 at review time) and propagates through the Jest/tooling graph. There is no published patched release listed by the [advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf). Do not accept untrusted glob patterns as build/test configuration; do not present an audit node count as independently exploitable plugin bugs. Follow [issue #11](https://github.com/yurika0211/vps-vault-sync/issues/11) for a supported upstream fix.

The esbuild [development-server advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99) is removed by upgrading past 0.24.2. This repository's build script does not use `serve`, and no production exploit of that advisory was demonstrated here.

Reproduce from `plugin/`:

```sh
npm ci
npm audit --registry=https://registry.npmjs.org
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run lint
npm run typecheck
npm test -- --runInBand
npm run build
npm run test:integration
```
