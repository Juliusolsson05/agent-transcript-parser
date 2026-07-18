# Transcript fixtures

These fixtures are synthetic, hand-reviewed provider records created to exercise the public transcript conversion contract. They are not copied from a developer's personal transcript directory and contain no credentials, user identifiers, repository secrets, or real provider session tokens.

The files intentionally preserve provider-specific envelope shapes while using obviously fictional IDs, timestamps, paths, messages, and tool output. A change to a fixture is a behavioral change: ordinary tests only read these files, and updates must be made explicitly in a reviewed commit.

WHY provenance lives beside the corpus: a future contributor must be able to decide whether a fixture is safe to publish without reconstructing its origin from an old issue or pull request. If a real captured transcript is ever added, document its provider/version, capture purpose, redaction procedure, and reviewer here before committing it.
