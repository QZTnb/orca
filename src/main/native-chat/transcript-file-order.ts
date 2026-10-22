import type { NativeChatMessage } from '../../shared/native-chat-types'

/** What a row's order depends on: the newest time above it and, when the row right above is a
 *  user row, that row's file and ordered times. */
export type TranscriptFileOrder = {
  latest: number
  userAbove?: { timestamp: number; ordered: number }
}

export const TRANSCRIPT_FILE_ORDER_START: TranscriptFileOrder = {
  latest: Number.NEGATIVE_INFINITY
}

/** Desktop orders terminal transcript rows by time, but the file holds the true order:
 *  Claude stamps a prompt it took mid-turn with when it was queued, then writes it
 *  where it read it, and a CLI may stamp every row of one response alike. So a row never
 *  sorts above the rows before it. Returns the row and the order the next row continues from. */
export function inTranscriptFileOrder(
  message: NativeChatMessage,
  order: TranscriptFileOrder
): { message: NativeChatMessage; order: TranscriptFileOrder } {
  const { timestamp } = message
  if (timestamp === null) {
    return { message, order: { latest: order.latest } }
  }
  const isUser = message.role === 'user'
  const ordered = orderedTimestamp(timestamp, order.latest, isUser ? order.userAbove : undefined)
  return {
    message: ordered === timestamp ? message : { ...message, timestamp: ordered },
    order: {
      latest: Math.max(order.latest, ordered),
      ...(isUser ? { userAbove: { timestamp, ordered } } : {})
    }
  }
}

function orderedTimestamp(
  timestamp: number,
  latest: number,
  userAbove: TranscriptFileOrder['userAbove']
): number {
  // Why: Claude stamps a pasted-image prompt and its image rows alike, and the chat pairs them by
  // that time, so a pair moved below earlier rows moves together.
  if (userAbove?.timestamp === timestamp) {
    return userAbove.ordered
  }
  // Why: one past, not equal: equal times fall back to id order, which can still put it first.
  return timestamp > latest ? timestamp : latest + 1
}
