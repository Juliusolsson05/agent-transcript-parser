# Pi 0.87.1 Session Files

Stage 0 recordings of the real `pi` (`@earendil-works/pi-coding-agent` 0.87.1)
driving Pi's own faux provider through a PTY, copied from
`pi-terminal-headless/testing/fixtures/live/<scenario>.json` (`files`). The
agent loop, session writer and file shape are Pi's own; only the model is
scripted. No login, network or real model was involved.

| File | Proves |
| --- | --- |
| `tree.jsonl` | `/tree` abandons two turns in the same file, then a branch summary plus a forked prompt; the active branch is the parentId chain from the last row |
| `compaction.jsonl` | a split-turn compaction whose `firstKeptEntryId` keeps an earlier row, and the model-written plaintext summary |
| `tool.jsonl` | thinking → text → toolCall block order, and the toolResult threaded by `toolCallId` |
| `abort.jsonl`, `error.jsonl` | `stopReason` `aborted` / `error` replies, which Pi never replays |
| `user-bash.jsonl` | the user's own `!cmd` as a `bashExecution` message |
| `v1-linear.jsonl`, `v2-hook-message.jsonl` | pre-migration shapes from the Pi census (text replaced by `<text:N>` length markers) |

Normalization: the sandbox cwd became `/sandbox/project`. Pi's system-prompt
snapshot (`role: system` rows and a compaction's `systemMessage`) keeps its
shape, with each text replaced by a `<text:N>` length marker. Faux tool-call ids
and timestamps are as recorded. These are not byte-identical to any private
session. Nothing here proves real-provider thinking signatures or image
round trips; those are covered only by schema-based tests.
