Status: Complete

# OpenCode transcript support plan

Issue: #22

## Outcome

Make OpenCode a first-class provider adapter in the neutral transcript engine.
Hosts must be able to decode OpenCode's supported JSON export shape and project
any neutral conversation into JSON accepted by OpenCode's supported import
command, without adding pairwise Claude/OpenCode or Codex/OpenCode translators.

## Constraints

- Treat the OpenCode CLI export object (`info` plus message `info`/`parts`) as
  the native source coordinate. OpenCode owns SQLite storage; the parser must
  not read or write its private database schema.
- Keep the parser pure and browser-safe. CLI execution, temporary files, model
  selection, and filesystem cleanup remain host responsibilities.
- Preserve user/assistant text, images, reasoning, and complete tool cycles.
  Drop or demote structures OpenCode cannot safely resume, and name every loss
  in the projection report.
- Generate valid `ses_`, `msg_`, and `prt_` identities deterministically from
  caller-controlled seeds so fixtures and host transactions are reproducible.
- Project only schema-minimal native records. Fabricating snapshots, costs, or
  provider metadata from a foreign provider would make synthetic history look
  provider-authored and create brittle dependencies on incidental export data.

## Implementation

1. Add OpenCode export shape types and a decoder into `ConversationDocument`.
2. Add prompt analysis for rewind/provider-host consumers.
3. Add an OpenCode native-resume projector using a host-supplied model profile,
   cwd, CLI version, and deterministic identity factory.
4. Export the adapter APIs and extend import-boundary/package-surface tests.
5. Add focused decoder/projector/round-trip tests, then run the package's full
   typecheck, test, and package verification.

## Verification

- `npm run check`
  - Contract check passed.
  - TypeScript check passed.
  - 24 test files / 100 tests passed.
  - Packed artifact exposed all four required public files.
- Isolated OpenCode 1.18.27 CLI import/export verification passed for both a
  blank projected session and a projected two-message conversation using
  temporary XDG state rather than the developer's personal OpenCode database.
