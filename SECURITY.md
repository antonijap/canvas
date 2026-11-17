## Reporting a problem

Report security problems privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Do not open a public issue, pull request or discussion about it.

Include what an attacker can do, the steps or a file that shows it, and the commit you tested. You will get a reply within a week. Please give the fix time to ship before you talk about it publicly.

## What counts

Canvas runs a local server on 127.0.0.1 and opens files people receive from others, so these matter most:

- A `.canvas` file, a pasted clipboard or a dropped file that reads, writes or sends files outside the document.
- A web page, or another process on the machine, that can reach the local server and change documents or run agent tools.
- Secrets (PostHog keys and the like) leaving the macOS Keychain or appearing in documents, logs or exports.
- Code execution from document content, shaders, widgets or MCP tool input.

## Supported versions

Only the latest commit on `main`.
