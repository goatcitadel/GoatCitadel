---
name: secure-coding
description: "Use when writing or reviewing code that handles user input, authentication, authorization, secrets, file paths or outbound requests, or when the operator asks for a security review or threat model."
metadata:
  version: "0.1.0"
  tags:
    - security
    - code
    - review
  tools:
    - fs.read
    - shell.exec
  keywords:
    - security review
    - threat model
    - owasp
    - sql injection
    - xss
    - csrf
    - secure coding
    - path traversal
---

# Secure Coding

> Adapted from addyosmani/agent-skills (`security-and-hardening`) at commit `8bfcc1f` (MIT License). Changes are listed in `UPSTREAM.md`.

Every value that crosses a trust boundary is hostile until checked. Find the boundaries first, then make the safe path the default one at each.

## When to use

- Code that reads request data, files, environment variables, or third-party responses.
- Login, sessions, permissions, secrets, uploads, outbound HTTP, or anything that builds a query, a path, or a command from input.
- A security review or threat model of existing code.

## When not to use

- Interface resilience such as empty states and error copy (use `@skill impeccable harden`).

## Workflow

1. **Map the trust boundaries.** List where untrusted data enters (request params, bodies, headers, cookies, uploaded files, webhooks, model output, third-party APIs) and where it lands (database, filesystem, shell, HTML, outbound requests, logs).
2. **Name the realistic threats** at each boundary: who could send what, and what they would gain.
3. **Apply the controls below** wherever the data lands.
4. **Test the hostile cases** next to the happy path: a traversal name, a script payload, another user's id, an oversized body.
5. **Report** what you found or added, and what risk remains.

## Controls

- **Validate at the boundary** with a schema: type, length, format, allowed values. Reject rather than repair.
- **Queries:** parameterized statements or the ORM's bindings, never SQL built from strings.
- **Output:** encode for the context it lands in (HTML, attribute, URL, JSON), keep the framework's escaping on, and sanitize any HTML that must stay HTML.
- **Authorization on every request:** check that this user may act on this object, not only that someone is signed in. Look objects up by owner, not by an id the client chose.
- **Files and paths:** resolve the path, then confirm it is still inside the allowed root; reject separators, `..`, and NUL bytes in names. Serve uploads with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, or from a separate origin. Apply the same check before deleting or overwriting any path derived from input.
- **Commands:** pass arguments as an array to the program, never through a shell string.
- **Outbound requests:** allowlist hosts, and refuse private, loopback, and link-local addresses after DNS resolution.
- **Sessions:** hash passwords with a slow algorithm (argon2, bcrypt, scrypt); set cookies `HttpOnly`, `Secure`, and `SameSite`; protect cookie-authenticated state changes against CSRF; rate-limit login and other expensive endpoints.
- **Secrets:** read them from the environment or a secret store, never from code, logs, URLs, or error messages. Example configs carry placeholders only.
- **Errors:** generic messages to clients, details in server logs with secrets redacted.
- **Dependencies:** run the ecosystem's audit (`npm audit`, `pip-audit`) and pin versions.
- **Model features:** treat model output and retrieved documents as untrusted input to every control above.

## Checklist

- [ ] Every boundary touched has schema validation.
- [ ] No SQL, command, or HTML is built from strings.
- [ ] Every object access checks ownership or role.
- [ ] Paths are resolved and confined to their root.
- [ ] Uploaded files cannot run as script on the app's origin.
- [ ] Outbound fetches are allowlisted.
- [ ] Cookie and CSRF settings are right, and logins are rate-limited.
- [ ] No secret appears in code, logs, URLs, or errors.
- [ ] Client-facing errors are generic.
- [ ] Hostile-input tests exist for each boundary touched.

## What the operator decides

- Which residual risks to accept, and anything that changes who may access what.
- Security changes that alter behavior for existing users, such as new limits or stricter validation.

## Output

1. The boundaries and threats considered.
2. The code, with each control tied to the threat it stops.
3. The hostile-input tests and their results.
4. Residual risks and what was not checked.

## Boundaries

- Commands run through `shell.exec` under the operator's shell policy and approvals.
- If you find what looks like a live secret, tell the operator so they can rotate it; do not repeat its value.

## Related skills

- `receiving-code-review` for security findings raised by a reviewer.
- `tdd` for writing the hostile-input tests first.
