# Grok 1.0.13 Conversation Records

`command.jsonl` is a minimized combination of the command probe's native
`chat_history.jsonl` records retained in grok-code-headless stage-0 evidence.
User query, assistant text, flat tool shape and result order are retained.
System/bootstrap/reminder contents were replaced, native IDs normalized, the
tool result reduced to its observed exit line, and encrypted reasoning plus
personal skill/MCP inventory removed. It is not byte-identical native evidence.

Proves: storage shape, semantic order, flat tool-call decoding and the difference
between bootstrap context and the genuine wrapped user query. Does not prove:
native compaction, image rendering, authorization, or successful native resume.
Additional literal fault-injection cases live in the tests and are not labeled
as observations. Source shape reference: xai-org/grok-build commit
72a61251fcffb464bcc687aeb5a998e5a98ec0c9, sampling-types/conversation.rs.
