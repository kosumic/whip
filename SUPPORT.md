# Support

Whip is an independent community project with best-effort support.

## Where to ask

- **Setup and usage questions:** use [GitHub Discussions Q&A](https://github.com/kosumic/whip/discussions/categories/q-a).
- **Ideas and early design feedback:** use [GitHub Discussions Ideas](https://github.com/kosumic/whip/discussions/categories/ideas).
- **Reproducible Whip bugs:** use the repository bug-report form.
- **Confirmed Whip feature work:** use the feature-request form.
- **Security concerns:** report privately through [SECURITY.md](SECURITY.md).
- **Herdr server or CLI bugs unrelated to Whip:** use the [upstream Herdr repository](https://github.com/herdrdev/herdr).
- **Tailscale account or network problems:** use Tailscale's support resources.

Before asking for connection help, confirm this command works from another SSH client:

```bash
ssh user@laptop.tailnet.ts.net 'herdr status server --json'
```

Include the Whip commit/tag, platform and OS version, device model, CPU architecture, Herdr version and protocol, and sanitized error text. For UI or terminal bugs, include redacted screenshots or a short recording when safe. Never include credentials, private keys, Tailnet IPs, hostnames, unredacted logs, or sensitive terminal contents.
