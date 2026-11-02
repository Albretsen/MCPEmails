# OpenAI plugin package ("Any Mailbox")

Source of the ZIP uploaded at platform.openai.com/plugins. The portal takes the
listing, MCP auth settings, test cases and release notes from this package.
Reviewer credentials are entered in the portal, never here.

To build a new version, bump `version`, update `release_notes`, then run this
from this folder and upload `any-mailbox.zip` under "Upload new version":

    zip -r -X ../any-mailbox.zip plugin.json mcp.json assets

Tool changes need no upload: deploy the server, then press Rescan on the MCPs tab.
