export const defaultDesktopLimits = Object.freeze({ memoryGb: 2, cpus: 2 })

export function validDesktopLimits(value) {
  return Number.isSafeInteger(value?.memoryGb) && value.memoryGb >= 2 && value.memoryGb <= 128
    && Number.isSafeInteger(value?.cpus) && value.cpus >= 1 && value.cpus <= 64
}

export function resourceArgs({ memoryGb, cpus }) {
  const memory = `${memoryGb}g`
  return ['--memory', memory, '--memory-swap', memory, '--cpus', String(cpus)]
}

export function inspectDesktopLimits(config, podman) {
  const limits = { memoryGb: config?.Memory / 1024 ** 3, cpus: config?.NanoCpus / 10 ** 9 }
  if (!validDesktopLimits(limits)) return
  const { Memory, MemorySwap } = config
  const noSwap = MemorySwap === Memory
  // Older desktops use the engine's default swap allowance for the original 2 GiB limit.
  const legacy = limits.memoryGb === 2 && limits.cpus === 2 && (MemorySwap === 2 * Memory || (!podman && MemorySwap === 0))
  if (noSwap || legacy) return { ...limits, noSwap }
}
