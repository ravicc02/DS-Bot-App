const prefix = 'DS Bot computer screenshot: '

export const computerImageName = (sessionId, turnId, { provider, model }) => prefix + JSON.stringify([sessionId, turnId, provider, model])

export const isComputerImage = attachment => typeof attachment?.name === 'string' && attachment.name.startsWith(prefix)

export function scopeComputerImages(messages, allowedName) {
  let changed = false
  const scoped = messages.map(message => {
    if (!Array.isArray(message.content)) return message
    let replaced = false
    const content = message.content.map(block => {
      if (block?.type !== 'image' || !isComputerImage(block.attachment) || block.attachment.name === allowedName) return block
      replaced = true
      return { type: 'text', text: '[Computer screenshot omitted. Observe the authorized target to get a current screenshot.]' }
    })
    if (!replaced) return message
    changed = true
    return { ...message, content }
  })
  return changed ? scoped : messages
}
