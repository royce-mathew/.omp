# Provider quota status

Adds `/quota` for the active OAuth provider. The extension refreshes usage every minute, accepts quota headers from normal Codex and Claude model responses, and emits `workspace-ui:quota` for a compatible status-line extension.

Supported OAuth providers:

- OpenAI Codex: primary (typically 5-hour) and secondary (typically weekly) windows.
- Anthropic Claude: 5-hour and weekly windows.
- GitHub Copilot: monthly premium-request quota.

It reads the active OAuth token through Pi's model registry, keeps parsed quota only in memory, and never persists credentials or raw provider responses.

Example `/quota` output:

```text
openai-codex: 5-hour: 78% remaining · resets today at 1:57 PM  •  Weekly: 30% remaining · resets Jun 28 at 8:57 AM
```
