import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import extractZip from 'extract-zip'
import { downloadRuntimeAsset } from './prepare-runtime.mjs'

const source = fileURLToPath(new URL('../src/computer/', import.meta.url))
const release = 'cua-driver-rs-v0.45.4'
const archiveName = 'cua-driver-rs-0.45.4-windows-x86_64-binary.zip'
const archiveDigest = '949927b4cb0519c6fb1377878d67d79a8d6fae7bc56cbed17c7aa26448d82cb5'
const wheelName = 'cua_driver-0.37.0-py3-none-manylinux_2_31_x86_64.whl'
const wheelDigest = 'e530ee36226d99516ef7ec696ba31d516e487ae5e5effdd5e2610c56af3eee19'
const executables = ['cua-driver.exe', 'cua-driver-uia.exe']

export async function prepareComputerRuntime({ output, cache }) {
  const destination = resolve(output, 'computer')
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, 'computer-staging-'))
  try {
    const [archive, wheel] = await Promise.all([
      downloadRuntimeAsset(`https://github.com/trycua/cua/releases/download/${release}/${archiveName}`, archiveDigest, cache),
      downloadRuntimeAsset(`https://files.pythonhosted.org/packages/3b/b0/97f6d8828b8a6ca3649ad7150ddbc23addde56f014c9bd407876484ecb8d/${wheelName}`, wheelDigest, cache),
    ])
    await extractZip(archive, { dir: staging })
    const image = join(destination, 'image')
    await mkdir(image, { recursive: true })
    for (const file of executables) await cp(join(staging, file), join(destination, file))
    for (const file of ['CUA-LICENSE.txt', 'seccomp.json']) await cp(join(source, file), join(destination, file))
    for (const file of ['Dockerfile', 'start-desktop.sh']) await cp(join(source, file), join(image, file))
    await cp(wheel, join(image, wheelName))
    await writeFile(join(image, '.dockerignore'), `*\n!Dockerfile\n!start-desktop.sh\n!${wheelName}\n`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = fileURLToPath(new URL('../build/runtime/', import.meta.url))
  const cache = process.env.DS_BOT_RUNTIME_CACHE ?? fileURLToPath(new URL('../build/runtime-cache/', import.meta.url))
  await prepareComputerRuntime({ output, cache })
}
