# How WhatsApp MCP works

Suppose you ask your agent, “Find the message about the telescope.” The agent calls `whatsapp_search_messages`. A local daemon searches an encrypted copy of the messages your linked device has seen. Your agent gets the matching rows back. Your phone can be offline during that search. Sending a reply takes a different path because WhatsApp has to verify the recipient and accept the new message.

## Follow a search from your agent to storage

1. Your agent starts `scripts/run.mjs` as a **stdio bridge**. Stdio means the agent and its child process exchange MCP requests through standard input and output.
2. The bridge reads the private API token and connects to the daemon over loopback HTTP. Several agents can each have a bridge and share one WhatsApp connection.
3. The daemon validates the tool arguments. For `whatsapp_search_messages`, it asks SQLite's full-text search index, FTS5, for matching message rows. SQLite applies chat and time filters and returns the newest matches first.
4. The tool response includes `source: "sqlite"`, the current messaging connection state, and the result in `data`. An empty array means the local archive has no match. Its coverage depends on the history WhatsApp supplied to this device. [Tool handlers](../src/tools/register.ts) · [Message store](../src/services/message-store.ts)

## Try it with a synthetic message

Run these examples from a Linux checkout with Node 24.22.x. Install dependencies with `npm ci` once. It also builds the server. The first exercise creates its own key and temporary database, writes one invented message, and closes and removes its own files. It works without linking a phone or running the daemon.

```bash
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageStore } from './dist/services/message-store.js'

const dir = await mkdtemp(join(tmpdir(), 'whatsapp-lesson-'))
let store
try {
  process.env.WHATSAPP_DB_KEY_FILE = join(dir, 'lesson.key')
  await writeFile(process.env.WHATSAPP_DB_KEY_FILE, randomBytes(32).toString('hex'), { mode: 0o600 })
  store = await MessageStore.open(join(dir, 'lesson.sqlite'))
  const key = { remoteJid: '15555550100@s.whatsapp.net', id: 'lesson-1', fromMe: false }
  const message = { key, messageTimestamp: 1700000000, message: { conversation: 'Pack the telescope' } }

  store.ingest(message)
  store.ingest(message)
  console.log('Rows after replay', store.list().length)
  console.log('Search result', store.list({ query: 'telescope' })[0].text)
  store.update(key, { message: null })
  console.log('Matches after revocation', store.list({ query: 'telescope' }).length)
  console.log('Stored message type', store.getMessage(key.remoteJid, key.id).type)
} finally {
  store?.close()
  await rm(dir, { recursive: true, force: true })
}
JS
```

The exercise prints four lines.

```text
Rows after replay 1
Search result Pack the telescope
Matches after revocation 0
Stored message type deleted
```

The second copy has the same protocol identity, so it updates the existing row. Revocation clears the body and its search terms. The row retains its identity so a later history replay can recognize the deletion.

To see the same architecture through its **public entry point**, run the following integration test. It creates temporary state, starts a real loopback HTTP daemon with WhatsApp network startup disabled, and connects an SDK client through the stdio bridge. It checks that all 20 tools are listed and that a history query returns an empty array from SQLite. [Integration fixture](../test/robustness.test.mjs)

```bash
node --test --test-name-pattern='documented setup, daemon and stdio bridge' test/robustness.test.mjs
```

## Follow a send after a timeout

Imagine an approved send with `request_id` set to `lesson-note-001`. That identifier belongs to the caller. The daemon verifies the chat, reserves a WhatsApp message ID, and records the operation before dispatch. WhatsApp may accept the send just as the connection drops. The daemon then has an `unknown` outcome. The recipient may already have the message.

Use the read-only tool `whatsapp_get_operation` with the original ID. The argument object contains one field.

```json
{ "request_id": "lesson-note-001" }
```

A later delivery or read receipt can advance the saved operation. For a group, that evidence can come from one participant. Changing the content while reusing the ID returns `REQUEST_ID_CONFLICT`. Generating a fresh ID creates a new send and can give the recipient a duplicate. You can observe a delayed network response and a later receipt with a fake socket. [Send and receipt tests](../test/robustness.test.mjs)

```bash
node --test --test-name-pattern='timeout never resends' test/robustness.test.mjs
```

## Choose the right voice feature

| You want to | What runs | Where to check the outcome |
| --- | --- | --- |
| Leave a voice note in a chat | Piper creates a WAV. FFmpeg encodes it as Opus, ffprobe verifies the codec, and Baileys sends an audio message with the push-to-talk flag. The recipient also gets a separate attribution text. | `whatsapp_get_operation` with the note's request ID |
| Speak during a call | The optional calling helper controls a separately linked WhatsApp Web browser. Piper generates speech and PipeWire feeds it into the browser's microphone. | `whatsapp_call_status` observes the call UI, including duration when visible |

The messaging connection reported by `whatsapp_get_status` and the browser session reported by `whatsapp_call_status` can have different states. Browser UI observation cannot confirm that the person heard the audio. Confirm the recipient and intent before a real send or dial. [Calling setup](../calling/README.md)

The high-level design maps the processes and data boundaries. The low-level design follows one request through the actual methods, tables and failure states. [High-level design](high-level-design.md) · [Low-level design](low-level-design.md)
