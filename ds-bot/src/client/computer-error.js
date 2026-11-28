import { hostText } from './i18n.js'

export function computerError(failure) {
  return hostText(failure.message.replace(/^Error invoking remote method '[^']+': Error: /u, ''))
}
