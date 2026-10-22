import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { projectNativeChatTranscriptMessages } from '../../shared/native-chat-transcript-projection'
import { readNativeChatTranscript } from './transcript-reader'
import { readNativeChatTranscriptTail, subscribeNativeChatTranscript } from './transcript-watch'

// A send while a tool runs: Claude stamps the queue entry at send time (10:00:10)
// but writes it after the tool result it read it with (10:00:30).
const PROMPT = {
  type: 'user',
  uuid: 'u-1',
  timestamp: '2026-06-01T10:00:00.000Z',
  message: { role: 'user', content: 'start the long task' }
}
const TOOL_CALL = {
  type: 'assistant',
  uuid: 'a-1',
  timestamp: '2026-06-01T10:00:01.000Z',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 30' } }]
  }
}
const TOOL_RESULT = {
  type: 'user',
  uuid: 'r-1',
  timestamp: '2026-06-01T10:00:30.000Z',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }]
  }
}
const QUEUED = {
  type: 'attachment',
  uuid: 'q-1',
  parentUuid: 'r-1',
  timestamp: '2026-06-01T10:00:10.000Z',
  attachment: {
    type: 'queued_command',
    prompt: 'also check the config',
    commandMode: 'prompt',
    origin: { kind: 'human' },
    timestamp: '2026-06-01T10:00:10.000Z'
  }
}
const REPLY = {
  type: 'assistant',
  uuid: 'a-2',
  timestamp: '2026-06-01T10:00:35.000Z',
  message: {
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'both done' }]
  }
}

const lines = (...records: object[]): string =>
  records.map((record) => `${JSON.stringify(record)}\n`).join('')

let roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

async function transcriptFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-transcript-file-order-'))
  roots.push(root)
  const filePath = join(root, 'session.jsonl')
  await writeFile(filePath, content)
  return filePath
}

/** What the chat draws: the prompt after the tool run, with the call holding its result. */
function expectPromptAfterToolRun(messages: NativeChatMessage[]): void {
  const rows = projectNativeChatTranscriptMessages(messages)
  expect(rows.map((row) => row.id)).toEqual(['u-1', 'a-1', 'q-1', 'a-2'])
  expect(rows[1]?.blocks.map((block) => block.type)).toEqual(['tool-call', 'tool-result'])
}

describe('transcript rows keep file order', () => {
  it.each([
    ['full read', (filePath: string) => readNativeChatTranscript('claude', 's', { filePath })],
    [
      'tail read',
      (filePath: string) =>
        readNativeChatTranscriptTail({ agent: 'claude', sessionId: 's', filePath, limit: 40 })
    ]
  ])(
    'places a mid-turn prompt after the tool result it was read with (%s)',
    async (_name, read) => {
      const filePath = await transcriptFile(lines(PROMPT, TOOL_CALL, TOOL_RESULT, QUEUED, REPLY))
      const result = await read(filePath)
      if (!('messages' in result)) {
        throw new Error(result.error)
      }
      expectPromptAfterToolRun(result.messages)
    }
  )

  // A CLI that stamps a response's thinking and answer rows alike; id order would put the answer first.
  it.each([
    ['full read', (filePath: string) => readNativeChatTranscript('claude', 's', { filePath })],
    [
      'tail read',
      (filePath: string) =>
        readNativeChatTranscriptTail({ agent: 'claude', sessionId: 's', filePath, limit: 40 })
    ]
  ])('keeps rows that share one timestamp in file order (%s)', async (_name, read) => {
    const at = '2026-10-21T14:47:08.596Z'
    const thinking = {
      type: 'assistant',
      uuid: 'z-thinking',
      timestamp: at,
      message: {
        role: 'assistant',
        stop_reason: null,
        content: [{ type: 'thinking', thinking: 'plan' }]
      }
    }
    const answer = {
      type: 'assistant',
      uuid: 'a-answer',
      parentUuid: 'z-thinking',
      timestamp: at,
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }]
      }
    }
    const filePath = await transcriptFile(lines(PROMPT, thinking, answer))
    const result = await read(filePath)
    if (!('messages' in result)) {
      throw new Error(result.error)
    }
    expect(projectNativeChatTranscriptMessages(result.messages).map((row) => row.id)).toEqual([
      'u-1',
      'z-thinking',
      'a-answer'
    ])
  })

  // Claude Code writes the prompt, then its image companion, at one time; folding pairs them by it.
  it('keeps a pasted-image prompt and its companion row on their shared timestamp', async () => {
    const at = '2026-10-21T07:04:59.367Z'
    const prompt = {
      type: 'user',
      uuid: 'image-prompt',
      timestamp: at,
      message: { role: 'user', content: [{ type: 'text', text: 'look at this [Image #1]' }] }
    }
    const companion = {
      type: 'user',
      uuid: 'image-companion',
      isMeta: true,
      timestamp: at,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Image: source: /tmp/orca-paste-a.png]' }]
      }
    }
    const filePath = await transcriptFile(lines(prompt, companion))
    const result = await readNativeChatTranscript('claude', 's', { filePath })
    if (!('messages' in result)) {
      throw new Error(result.error)
    }
    expect(result.messages.map((message) => [message.id, message.timestamp])).toEqual([
      ['image-prompt', Date.parse(at)],
      ['image-companion', Date.parse(at)]
    ])
  })

  it('places a mid-turn prompt appended after the initial snapshot', async () => {
    const filePath = await transcriptFile(lines(PROMPT, TOOL_CALL, TOOL_RESULT))
    const received: NativeChatMessage[] = []
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 's',
      filePath,
      initialLimit: 40,
      onInitialSnapshot: (messages) => received.push(...messages),
      onAppend: (messages) => received.push(...messages),
      debounceMs: 5,
      reconciliationIntervalMs: 20
    })
    try {
      await expect.poll(() => received.length).toBe(3)
      await appendFile(filePath, lines(QUEUED, REPLY))
      await expect.poll(() => received.length).toBe(5)
      expectPromptAfterToolRun(received)
    } finally {
      subscription.unsubscribe()
    }
  })
})
