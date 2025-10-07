<div align="center">
  <h1 align="center"><a href="https://www.epicweb.dev/epic-stack">The Epic Stack 🚀</a></h1>
  <strong align="center">
    Ditch analysis paralysis and start shipping Epic Web apps.
  </strong>
  <p>
    This is an opinionated project starter and reference that allows teams to
    ship their ideas to production faster and on a more stable foundation based
    on the experience of <a href="https://kentcdodds.com">Kent C. Dodds</a> and
    <a href="https://github.com/epicweb-dev/epic-stack/graphs/contributors">contributors</a>.
  </p>
</div>


Test comment

```sh
npx epicli
```

[![The Epic Stack](https://github-production-user-asset-6210df.s3.amazonaws.com/1500684/246885449-1b00286c-aa3d-44b2-9ef2-04f694eb3592.png)](https://www.epicweb.dev/epic-stack)

[The Epic Stack](https://www.epicweb.dev/epic-stack)

<hr />

## Watch Kent's Introduction to The Epic Stack

[![Epic Stack Talk slide showing Flynn Rider with knives, the text "I've been around and I've got opinions" and Kent speaking in the corner](https://github-production-user-asset-6210df.s3.amazonaws.com/1500684/277818553-47158e68-4efc-43ae-a477-9d1670d4217d.png)](https://www.epicweb.dev/talks/the-epic-stack)

["The Epic Stack" by Kent C. Dodds](https://www.epicweb.dev/talks/the-epic-stack)

## Docs

[Read the docs](https://github.com/epicweb-dev/epic-stack/blob/main/docs)
(please 🙏).

### Project-specific docs

- System Specification (single source of truth): `docs/INTEREX_SYSTEM_SPEC.md`

Legacy multi-file docs have been consolidated. See `docs/SECURITY_ENHANCEMENT_PHASES.md` for the phased security roadmap.

## Support

- 🆘 Join the
  [discussion on GitHub](https://github.com/epicweb-dev/epic-stack/discussions)
  and the [KCD Community on Discord](https://kcd.im/discord).
- 💡 Create an
  [idea discussion](https://github.com/epicweb-dev/epic-stack/discussions/new?category=ideas)
  for suggestions.
- 🐛 Open a [GitHub issue](https://github.com/epicweb-dev/epic-stack/issues) to
  report a bug.

## Branding

Want to talk about the Epic Stack in a blog post or talk? Great! Here are some
assets you can use in your material:
[EpicWeb.dev/brand](https://epicweb.dev/brand)

## Thanks

You rock 🪨

## Authentication

The deployment has been simplified to support only username/password plus mandatory TOTP MFA. All OAuth provider code (GitHub strategy, connection management UI/routes, provider onboarding flows) and associated tests were removed to reduce complexity and attack surface. Passkeys (WebAuthn) are presently disabled and slated for future evaluation; related experimental code may still exist under `webauthn+` but is not active in the auth flow.

Rationale:
- Eliminate unused third‑party auth dependencies and configuration.
- Reduce session complexity (no provider link/unlink edge cases).
- Focus security hardening & test coverage on a single, mandatory MFA path.