// Builds client.js, the browser half, from the modules in src/client.
//
//   node scripts/build-client.mjs           writes client.js
//   node scripts/build-client.mjs --check   exits 1 when client.js differs from a fresh build
//
// client.js is committed, so `link:` and git installs need no build step. dsh loads it as
// a classic script; the wrapper mirrors packages/client/tsdown.client.ts in
// deepseek-harness: `require` resolves the shell-seeded platform modules (react,
// react-dom, ui-primitives, ...), which therefore stay external.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(PLUGIN, 'client.js')
const PLATFORM_MODULES = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

// noVNC has top-level await. Initialize its self-contained ESM bundle in a lazy
// async closure inside DSH's classic-script module loader, without eval or extra routes.
async function desktopClient() {
  const { outputFiles } = await build({
    absWorkingDir: PLUGIN,
    stdin: { contents: "export { default } from '@novnc/novnc'", resolveDir: PLUGIN },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    minify: true, legalComments: 'inline',
  })
  const code = outputFiles[0].text.trimEnd()
  const tail = /export\{([\w$]+) as default\};$/u.exec(code)
  if (!tail) throw new Error('Unexpected noVNC bundle format')
  return 'let pending; export default function loadRfb() { return pending ??= (async () => {'
    + code.slice(0, tail.index) + 'return ' + tail[1] + '; })() }'
}

export async function desktopClientPlugin() {
  const desktop = await desktopClient()
  return { name: 'desktop-client', setup(builder) {
    builder.onResolve({ filter: /^ds-bot-desktop-client$/ }, () => ({ path: 'rfb', namespace: 'ds-bot' }))
    builder.onLoad({ filter: /.*/, namespace: 'ds-bot' }, () => ({ contents: desktop }))
  } }
}

export async function bundleClient() {
  const result = await build({
    // Region comments name sources relative to the plugin, wherever the script runs from.
    absWorkingDir: PLUGIN,
    entryPoints: ['src/client/index.js'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: PLATFORM_MODULES,
    plugins: [await desktopClientPlugin()],
    // Every source declaration ships, used or not, as in the hand-written bundle.
    treeShaking: false,
    // Readable for debugging in the browser: no minification, and Chinese text stays text.
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return [
    '// Generated from src/client by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
    'window.__ModuleLoader__.load({',
    '  id: \'ds-bot\',',
    '  factory: (require) => {',
    'const module = { exports: {} }',
    result.outputFiles[0].text.trimEnd(),
    // The loader gets a plain exports object tagged as a module, as the tsdown preset
    // emits, rather than esbuild's getter-based `__esModule` object.
    'return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: \'Module\' })',
    '  },',
    '})',
    '',
  ].join('\n')
}

const OFFICE_OUTPUT = join(PLUGIN, 'office.js')

export async function bundleOffice() {
  const result = await build({
    absWorkingDir: PLUGIN,
    entryPoints: ['src/office/cli.js'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
    banner: {
      js: '#!/usr/bin/env node\n// Generated from src/office by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
    },
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return result.outputFiles[0].text
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await bundleClient()
  const office = await bundleOffice()
  if (process.argv.includes('--check')) {
    let current = null, currentOffice = null
    try { current = readFileSync(OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
    try { currentOffice = readFileSync(OFFICE_OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
    if (current !== next || currentOffice !== office) {
      console.error('client.js or office.js is stale: run `npm run build` in ds-bot and commit the result')
      process.exit(1)
    }
  } else {
    writeFileSync(OUTPUT, next)
    writeFileSync(OFFICE_OUTPUT, office)
  }
}
