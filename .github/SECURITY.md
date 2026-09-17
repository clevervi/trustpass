# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

Only the latest release receives security patches. Older versions are not
backported unless the fix is trivial and the exposure is critical.

## Reporting a Vulnerability

**Do not open a public issue.** Security vulnerabilities must be reported
privately so that a fix can be prepared before disclosure.

Send an email to **raivel.studio@gmail.com** with:

1. A description of the vulnerability and its impact.
2. Steps to reproduce, including any relevant payloads or configurations.
3. The component affected (`api`, `web`, `db`, `contracts`, `ci`).
4. Your assessment of severity (low, medium, high, critical).

### What to expect

| Step                        | Timeline            |
| --------------------------- | ------------------- |
| Acknowledgement of report   | Within 48 hours     |
| Initial triage and severity | Within 5 days       |
| Fix available or workaround | Within 30 days      |
| Public disclosure            | After fix is released |

If the timeline slips, we will notify you with an updated estimate.

### What happens next

1. We confirm the vulnerability and assess its severity.
2. A fix is developed on a private branch (not visible until merge).
3. A patch release is cut and the advisory is published.
4. Credit is given to the reporter unless anonymity is requested.

## Scope

The following are in scope:

- Authentication and authorization bypasses
- Data exposure (personal data, internal keys, credentials)
- Injection vulnerabilities (SQL, NoSQL, command, template)
- Cross-site scripting (XSS) and cross-site request forgery (CSRF)
- Insecure direct object references
- Dependency vulnerabilities with a known exploit path
- CI/CD pipeline compromise vectors

The following are **out of scope**:

- Denial of service (the service is not yet publicly deployed)
- Social engineering attacks
- Physical security of hardware running the service
- Vulnerabilities in dependencies without a demonstrated exploit

## Security Tooling

This project runs the following automated security gates on every pull request:

- **Gitleaks** — scans the full git history for committed secrets
- **CodeQL** — static analysis for security and quality defects (weekly)
- **Dependency review** — blocks PRs introducing dependencies with known
  vulnerabilities or copyleft licences
