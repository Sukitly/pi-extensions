# OpenDesign Cloud for Pi

Registers OpenDesign's OpenAI Chat Completions endpoint as a native Pi provider.
The three model IDs are fixed: `deepseek-v4.1-flash`, `minimax-m3.1-flash`
and `glm-5.3-flash`. Availability depends on your OpenDesign account.

This directory is in Pi's global extensions directory, so restart Pi or run
`/reload`, then:

1. Run `/login open-design` and choose **Sign in with OpenDesign account**.
   Open the displayed URL and approve the device code. Pi stores the resulting
   runtime and control credentials in its native `auth.json` provider entry.
2. Run `/model` and choose an `open-design` model. The usage widget appears
   below the editor and refreshes automatically.
3. Send a short message, then ask it to read a file to verify tool calls.
4. `/logout open-design` removes the local Pi credential, **not necessarily
   the server-side device authorization**. See the security note below.

You can instead choose the API key option in `/login open-design`, or set
`OPEN_DESIGN_API_KEY` before starting Pi. A standard API key can call models
but cannot query account usage, so the usage widget requires account login.
Pi keeps one stored credential per provider; switching login methods replaces
that stored credential. An environment key may remain usable after logout.

The existing `pi-oauth-accounts` extension now automatically adopts these
credentials through `/accounts`, including older logins with an empty refresh
field; no re-login is needed for adoption. It switches runtime and control keys
together. New device logins also retain returned account ID, email, user info,
control-key ID and any supplied refresh token. A refresh token is not used
without a verified refresh mechanism. Older logins lacking identity can be
renamed in `/accounts`; no identity is guessed from a secret key.

## Limitations

- **Security:** device authorization issues a control key with broader account
  and billing access, not a usage-only key, and can issue a runtime key. Pi's
  `auth.json` is a local credential file, not an encrypted secret vault; protect
  its permissions and backups. According to [issue #8870](https://github.com/nexu-io/open-design/issues/8870),
  device credentials could not be individually listed or revoked in the
  console. Local logout only removes Pi's copy. Confirm the provider's current
  revocation policy before authorizing.
- No authenticated live-account test has been performed. Device login, runtime
  key compatibility with Chat Completions, usage endpoints, model entitlement,
  streaming and tool calls must be verified with an account. Tests use mocks.
- The usage integration relies on OpenDesign's non-public control-plane
  contract and may break if it changes. It uses Pi's `readStoredCredential`
  helper for the standard file-backed credential store; a custom in-memory SDK
  credential store is not visible to this helper. Model API key login does not
  grant access to the usage endpoint.
- OpenDesign does not document credential expiry or refresh in this flow. Pi's
  required expiry field uses a sentinel, not an assertion that credentials are
  permanent. Re-login if the server rejects them; no fake refresh is performed.
- Model capabilities, thinking levels, context and output limits now use the
  same Pi built-in catalog matching as Command Code, rather than hard-coded
  128K/text-only defaults. These are upstream metadata, not verified gateway
  guarantees; use models.json overrides if OpenDesign imposes different limits.
- Pi's displayed cost is zero because plan credits are not a per-token price;
  **zero does not mean free**. Check the Cloud console for real usage.
- The model catalog is static; there is no automatic model discovery. Usage
  shows only actual returned windows and marks failed refreshes as stale.

## Shared implementation

`../provider-shared/` contains catalog matching, the themed 10-column usage
renderer (local reset times and weekly pace), and the usage lifecycle used by
both this extension and Command Code. OpenDesign only adapts its auth and API
responses. Refresh runs at session start, model selection, agent completion
and account changes, with the same 3-minute successful-refresh throttle;
there is no separate polling timer. Keep the sibling shared directory when
moving/installing this extension.

## Tests

Run `npm test`. The test runner resolves Pi packages from a local installation;
set `PI_NODE_MODULES` if they are not under
`~/.pi/agent/install/releases/<current-version>/node_modules`.
