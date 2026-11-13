# Security reports

This project is under development. The documented compatibility target is DSH
`0.1.6-alpha.2` with the included session-event patch; other DSH versions have not
been qualified. Product acceptance gaps remain in [docs/acceptance.md](docs/acceptance.md).

Do not disclose credentials, activation tickets, private certificates, user files
or exploit details in a public issue. If the repository's **Security → Report a
vulnerability** entry is available, use it to send a private advisory. If it is
unavailable, open a public issue containing only a request for a private reporting
channel; wait for a maintainer to arrange that channel before sending details.
No private email address or response-time commitment is currently published.

Describe the affected commit/version, prerequisites, expected boundary and a
sanitized reproduction. Do not test against another person's DSH installation.
Local downstream MCP commands retain their own permissions; cwd and roots do not
create a filesystem sandbox. Development TLS material is local and must never be
used for a public deployment.
