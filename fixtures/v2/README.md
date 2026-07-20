# V2 evidence fixtures

This directory separates evidence by provenance because a fixture can only prove
what its source supports.

- `observed/` contains value-redacted structural reductions selected from the
  local real-transcript corpus. Each case is the smallest observed record for a
  reviewed provider discriminator. It can prove that a wire shape occurred and
  can support classification tests. It cannot prove native resume behavior or a
  cross-provider semantic mapping.
- `manifest.schema.json` makes those limits executable. Every case states what
  it proves, what it explicitly does not prove, how it was normalized, and a
  SHA-256 digest of the private source record without retaining its path or
  session identity.

The raw corpus is never committed. The checked-in records replace prompts,
commands, outputs, paths, URLs, identifiers, timestamps, model names, and
potentially sensitive scalar values. Reviewed provider schema discriminators
such as `response_item`, `tool_use`, and `compact_boundary` remain because they
are the evidence being catalogued.

`observed/catalog.json` records frequency and file cardinality at extraction
time. Frequency is descriptive, not a stability guarantee: provider stores are
live and subsequent runs will naturally see additional records.

WHY one directory per case instead of a flat pile of JSONL: provenance and
claim strength must travel with the record. A future contributor should not be
able to copy a fixture into a native-resume test while overlooking the adjacent
statement that it only proves observed shape/classification.
