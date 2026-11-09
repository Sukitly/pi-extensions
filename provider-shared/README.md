# Shared gateway helpers

Used by `../command-code/` and `../open-design/`; this is not an extension entry point.

- `catalog.ts`: Command Code's built-in catalog matching, parameterized by provider and base URL.
- `widget.ts`: the same themed 10-column bars, local reset times and weekly pace indicator for both providers.
- `usage-lifecycle.ts`: Pi widget factories, session/model/agent hooks, three-minute refresh throttle, stale data and cancellation. No polling timer or private credential storage.

Provider-specific code supplies native authentication, credential resolution, API requests and response adapters. Keep this sibling directory when installing either extension.
