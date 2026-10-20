const post = {
  slug: 'what-is-an-app-password',
  title: 'What Is an App Password? Where to Create One for Each Email Provider',
  description:
    'What an app password is, why mail apps and AI connectors need one, where to create it for Gmail, iCloud, Yahoo, AOL, Fastmail and Zoho, and how to revoke it.',
  cover: '/blog/cover-is-it-safe-to-give-ai-agent-email-access.svg',
  coverAlt: 'An app password connecting an email inbox to an AI agent through MCPEmails',
  authorId: 'asgeir',
  publishedAt: '2026-10-21T09:00:00.000Z',
  updatedAt: '2026-10-21T09:00:00.000Z',
  tags: ['App passwords', 'IMAP', 'Security', 'Email'],
  featured: false,
  content: `An **app password** is a separate password that your email provider generates for one app, so that app can sign in to your mailbox without your real account password. You create it in your account's security settings, paste it into the mail client or connector once, and delete it whenever you want that one app cut off. Your normal password, and every other app, keeps working.

If you are connecting a mailbox to Thunderbird, Apple Mail, or an AI agent through an MCP server such as MCPEmails, a missing or wrong app password is the most common reason the login fails. This guide explains what an app password is, why IMAP clients need one, where each major provider keeps the generator, and how to revoke one.

**Jump to:** [Where to create one](#where-to-create-an-app-password-for-each-provider) · [How to revoke one](#how-to-revoke-an-app-password) · [Security notes](#security-notes) · [FAQ](#faq)

## What is an app password?

An app password is a long, randomly generated credential tied to your email account but issued for a single application. Three things set it apart from the password you type into webmail:

- **The provider generates it.** You do not choose it. Google produces a 16-character code, Apple shows one in the form \`abcd-efgh-ijkl-mnop\`, and most providers show it exactly once.
- **It stands in for your password where a second factor cannot be asked.** Mail clients connect over IMAP (reading) and SMTP (sending), and those protocols cannot show a two-factor prompt. An app password is the provider's way of letting such a client in without weakening sign-in on the web.
- **It can be revoked on its own.** Delete it and only the app that used it loses access. Nothing else on the account changes.

Google describes it as a 16-digit passcode that gives an app or device permission to access your Google Account (in practice the code is 16 letters). Apple calls the same idea an **app-specific password**, Zoho an **application-specific password**, GMX and WEB.DE an **App-Passwort**. They all mean the same thing.

## Why IMAP clients and AI connectors need one

Many mail providers no longer accept your normal password from a third-party mail app, especially once two-factor authentication is on. A desktop mail client, a phone's built-in mail app, or a server that reads mail on your behalf all speak IMAP and SMTP, and at Google, Apple, Yahoo, AOL, Fastmail and Yandex the credential those protocols accept is an app password.

An AI connector is in exactly the same position. When Claude or ChatGPT works with your inbox through [an MCP email server](/blog/what-is-an-mcp-email-server), the AI does not log in to your mailbox itself. The MCP server does, over IMAP and SMTP, the same way Thunderbird would. So for iCloud, Yahoo, AOL, Fastmail, Gmail and similar providers, the server needs an app password, and the AI client gets only a scoped token for the server. The [guide to OAuth and API keys for email access](/blog/oauth-vs-api-keys-ai-email-access) covers that second layer.

The common mistake is pasting the password you use on the provider's website. In MCPEmails' own connection logs, 72.9% of failed inbox connections were a rejected login, and the usual cause was an account password entered where an app password belongs. Generated app passwords have a recognisable shape, so the MCPEmails connect form checks what you paste for Gmail, iCloud, Yahoo, Yandex and Fastmail and warns you before the attempt reaches the provider, which would otherwise count it as a failed sign-in. If you are sure the value is right, pressing Connect again sends it anyway.

## Where to create an app password for each provider

Each entry below says where the generator lives and what has to be switched on first. The linked setup page for each provider has the IMAP and SMTP settings and the full steps.

- **Gmail and Google Workspace:** turn on 2-Step Verification, then create one at \`myaccount.google.com/apppasswords\`. The code is 16 letters shown in four groups; spaces do not matter. Google lists three cases where the option is missing: some work, school or other organization accounts (on Workspace, that is your administrator's setting), Advanced Protection, and 2-Step Verification set up only with security keys. Setup: [Gmail](/connect/gmail), [Google Workspace](/connect/google-workspace).
- **iCloud Mail:** two-factor authentication is required. At \`account.apple.com\`, open **Sign-In and Security**, then **App-Specific Passwords**, and generate one. You can have up to 25 active at once. Setup: [iCloud Mail](/connect/icloud).
- **Yahoo Mail:** on the Yahoo **Account Security** page, under **External connections**, choose **Create app password**, name it, and generate it. Setup: [Yahoo Mail](/connect/yahoo).
- **AOL Mail:** on the AOL **Account Security** page, choose **Generate app password** (some accounts show **Generate and manage app passwords**), then **Get Started**, name it, and generate it. AOL asks you to do this in a browser you have used to sign in to AOL Mail for several days, not in a private window. A Yahoo app password does not open an AOL mailbox, even though the two run on the same platform. Setup: [AOL Mail](/connect/aol).
- **verizon.net:** Verizon retired its mail service and surviving verizon.net mailboxes are AOL accounts now, so you create an **AOL** app password and sign in with your full verizon.net address. Setup: [verizon.net](/connect/verizon).
- **Fastmail:** go to **Settings**, **Privacy & Security**, **Connected apps & API tokens**, **Manage app passwords and access**, **New app password**. Keep the default access level, **Mail, Contacts & Calendars**; a Files-only password cannot log in to mail. Fastmail connects with an app password only, and Fastmail's Basic plan cannot create one. Setup: [Fastmail](/connect/fastmail).
- **Zoho Mail:** first enable **IMAP Access** in Zoho Mail under **Settings**, **Mail Accounts**. Without two-factor authentication your Zoho password works; with two-factor authentication, federated sign-in (for example signing in with Google) or SAML, create an application-specific password in your Zoho account and use that. Setup: [Zoho Mail](/connect/zoho).
- **Yandex Mail:** enable IMAP under **Mail clients** in Yandex Mail settings, then on the security page at \`id.yandex.com\` open **App passwords** and create one for an email client. Yandex shows it once. Setup: [Yandex Mail](/connect/yandex).
- **GMX:** switch on **POP3/IMAP** access in the email settings first. Without two-factor authentication your normal GMX password works; with it, create an App-Passwort under **Account verwalten**, **Login & Sicherheit**, **App-Passwörter (für externe Apps)**, **Neues App-Passwort erstellen**. GMX shows it once. Setup: [GMX](/connect/gmx).
- **WEB.DE:** the same as GMX: enable **POP3/IMAP** access, and create an App-Passwort in the same place if two-factor authentication is on. Setup: [WEB.DE](/connect/web-de).
- **Outlook.com, Hotmail and Live:** no app password. Microsoft says Basic Authentication, the password sign-in that app passwords rely on, is no longer available for any Outlook account after 16 September 2024, so an app password cannot open the mailbox. MCPEmails connects these accounts with **Sign in with Microsoft** through Microsoft Graph instead. Setup: [Outlook.com](/connect/outlook); work accounts are covered in the [Microsoft 365 guide](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Anything else, such as a mailbox at your web host or on your own domain, follows the same pattern: generate an app password if the provider offers one, otherwise use the mailbox password, and enter the host settings by hand. The [generic IMAP page](/connect/imap) and the [full list of providers](/connect) cover those.

## How to create one and connect your inbox

The steps are the same everywhere, only the menu names change:

1. Turn on two-factor authentication on the email account if the provider requires it.
2. Open the app password page listed above, name the password after the app (for example \`MCPEmails\`), and generate it.
3. Copy it immediately. Most providers will not show it again.
4. In MCPEmails, open **Inboxes**, then **Connect inbox**, choose your provider, and paste your full email address and the app password.
5. Add \`https://mcpemails.com/api/mcp\` to your AI client. The [Claude guide](/blog/connect-claude-to-email) and the [ChatGPT guide](/blog/connect-chatgpt-to-email) walk through that part.

If the login is still refused, the [IMAP connector guide](/blog/claude-imap-connector) lists the other usual causes: IMAP switched off, the wrong regional host, or a username that is not the full address.

## How to revoke an app password

Revoking is how you end one app's access without touching anything else. Delete the password in the same place you created it:

- **Google:** \`myaccount.google.com/apppasswords\`, then **Remove** next to the entry. Changing your Google Account password also revokes every app password.
- **Apple:** **Sign-In and Security**, **App-Specific Passwords**, then remove one or use **Revoke All**. Changing or resetting your Apple Account password revokes all of them automatically.
- **Yahoo and AOL:** the **Account Security** page (**External connections** at Yahoo, **Generate and manage app passwords** at AOL), then **Delete** next to that app password. Changing your main password does **not** revoke app passwords here, so deleting the entry is the only way to cut a client off.
- **Fastmail, Zoho, Yandex, GMX, WEB.DE:** remove it from the same app password list where you created it. At Yandex, signing out on all devices also resets every app password.

On the MCPEmails side, **Disconnect inbox** in the dashboard clears the stored app password along with the connection. Doing both is the clean way to retire an integration: the provider stops accepting the password, and MCPEmails no longer holds it.

## Security notes

- **Create one per app.** A separate, named app password for each client means you can revoke one without breaking the others, and the list in your account shows who still has access.
- **Treat it like a password.** An app password signs in without asking for your second factor, which is the point of it. Do not paste it into a chat with an AI, a shared document or a support ticket. In MCPEmails it goes into the connect form only.
- **It is usually full mail access.** On most providers an app password can read, send and delete mail, not a subset. Narrow what your AI can do at the connector instead: MCPEmails lets you approve \`read:email\` without \`send:email\`, and the [email-access safety guide](/blog/is-it-safe-to-give-ai-agent-email-access) covers reviewing sends.
- **Know where it is stored.** MCPEmails keeps the app password encrypted with AES-256-GCM, decrypts it only on the server to reach your provider, and never passes it to the AI client. Your messages are fetched live and not stored. [Why that matters](/blog/why-email-never-stored-matters).
- **Google recommends Sign in with Google where an app offers it.** Google says app passwords are not recommended and are unnecessary in most cases. They exist for apps that cannot use that sign-in, which includes IMAP clients that only take a password.

## FAQ

**What is an app password?**
An app password is a randomly generated password your email provider issues for one app or device, such as a mail client or an AI email connector. It lets that app sign in over IMAP and SMTP without your main password, and you can delete it at any time to revoke that app alone.

**Is an app password the same as my email password?**
No. Your email password is the one you chose and type into webmail. An app password is generated by the provider, used only by one app, and on most providers your normal password will not work in its place.

**Why do I need an app password to connect email to an AI agent?**
Because the MCP server that gives the AI access signs in to your mailbox over IMAP and SMTP, like any mail client, and most providers accept only an app password there. Outlook.com is the main exception: it connects with Sign in with Microsoft.

**Does an app password expire?**
It stops working when you delete it. Google and Apple also revoke all app passwords when you change your main account password, while Yahoo and AOL keep them valid after a password change until you delete them.

**I lost my app password. Can I see it again?**
No. Most providers show it only once. Delete the old one, generate a new one, and paste the new one into the app. In MCPEmails, open the inbox and choose **Reconnect**.

## Next step

[Create a free MCPEmails account](/signup), generate an app password for your provider, and connect the inbox. The [provider matrix](/docs/providers) shows what each provider supports once it is connected.`,
};

export default post;
