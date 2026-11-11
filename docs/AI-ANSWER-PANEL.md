# AI answer panel

A fixed set of 16 questions, asked every week in the same four answer engines, to see whether AI answers name MCPEmails and which pages they cite. Pair it with the database scoreboard in `docs/sql/ai-answer-scoreboard.sql`, which shows whether those answers turn into signups.

Keep the questions word for word. Changing the wording breaks the week-over-week comparison; if a question has to change, retire it and add a new numbered one.

## How to run it

Run once a week, on Monday, for all 16 questions in each engine:

- **ChatGPT**: chatgpt.com, signed in, a new **temporary chat** for every question (no memory, no custom instructions), web search on. If the answer does not show sources, ask nothing else; log it as "no search".
- **Perplexity**: perplexity.ai, default mode, a new thread per question.
- **Gemini**: gemini.google.com, a new **temporary chat** per question (the signed-in account has history about us, which would bias a normal chat).
- **Google AI Mode**: `https://www.google.com/search?q=<url-encoded question>&udm=50&hl=en&gl=us`, one page per question. Google's AI features are already a third of our search impressions (Search Console, Generative AI report: 21.9K of 69.8K impressions in the 28 days to 2026-11-09).

Do not run the panel in a Claude account that has the MCPEmails connector installed: Claude then calls our tools instead of searching, and the answer says nothing about what Claude recommends.

Paste the question exactly as written below. Do not follow up, do not correct the engine, and do not click our links from the answer (a click from us would land in the signup numbers).

## What to log

One row per engine and question, in the shared log sheet:

| field | what to write |
|---|---|
| date | the day you ran it, YYYY-MM-DD |
| engine | chatgpt, perplexity, gemini or ai_mode |
| question | the number, 1 to 16 |
| named_us | yes if the answer names "MCPEmails", "MCP Emails", "mcpemails" or "Any Mailbox" anywhere, else no |
| rank | our position among the email tools the answer recommends (1 = first named), blank if not named |
| competitors | every other email tool or MCP server named, comma separated, in the order given |
| cited_urls | every cited URL, ours first; note the path for ours (for example /connect/yahoo) |
| notes | anything odd: wrong price, wrong claim about us, no web search, refusal |

If an answer says something false about MCPEmails (a price, a provider we do not support, a feature), log it in notes and raise it: wrong facts in answers are fixed on our pages, not in the engines.

## The questions

Questions 1 to 6 are the unbranded core set used for the target. Question 7 is branded (it names us) and is tracked but never counts toward the target. Questions 8 to 12 were added on 2026-10-20 and are unbranded; they widen coverage and get their own baseline from their first run.

1. How do I connect my iCloud mail to ChatGPT so it can read and reply to my email?
2. Search the web: what is the best way to connect iCloud or Yahoo mail to ChatGPT or Claude so the AI can read, search and reply to my email? Name specific tools.
3. Search the web: what are the best email MCP servers in 2026? I want one that works with any mailbox, not just Gmail.
4. Search the web: is there a hosted MCP server that connects Claude to a Yahoo Mail or IMAP mailbox without running anything locally? Compare the options and prices.
5. Search the web: how do I connect my Yahoo Mail to ChatGPT so it can search my inbox and draft replies?
6. Search the web: I have email on my own domain hosted at IONOS. How can I let ChatGPT or Claude read and send email from that mailbox?
7. Search the web: Mailopoly vs MCPEmails vs Mailbox MCP for connecting email to ChatGPT. Which is best and why? *(branded)*
8. Search the web: how do I connect my Outlook.com or Hotmail account to ChatGPT so it can read my inbox and write replies?
9. Search the web: can I connect my AOL Mail account to ChatGPT or Claude? Which tools support AOL?
10. Search the web: what is the easiest way to give Claude access to my Zoho Mail inbox so it can search and draft emails?
11. Search the web: I use email on my own domain, not Gmail. How do I connect that mailbox to Claude so it can read and reply to email?
12. Search the web: is there a safe way to give ChatGPT or Claude read-only access to my email, so it can search and summarize but never send or delete anything?

Questions 13 to 16 were added on 2026-11-11, unbranded, for the segments the native connectors do not cover (several mailboxes, custom domains, personal Outlook.com in Claude). Their baseline is their first full run.

13. How do I connect my Yahoo Mail inbox to Claude or ChatGPT so it can read my mail and draft replies? Which tools or services do you recommend?
14. Search the web: I have three email accounts (Gmail, Yahoo and my work address on my own domain). How can I let Claude or ChatGPT search and reply across all of them in one place?
15. Search the web: my business email is on cPanel hosting with my own domain. How do I connect it to Claude so it can read and send email?
16. Search the web: Claude's Microsoft 365 connector does not accept my personal Outlook.com account. How else can I connect Outlook.com or Hotmail to Claude?

## Baseline, 2026-10-19

Answer panel (questions 1 to 7; 8 to 12 had not been run yet):

- **ChatGPT** named us in 2 of 7 answers. Only 1 of those was unbranded: question 4 (hosted, Yahoo, Claude), where we ranked 1st and the answer cited /connect/yahoo. The other was question 7, which names us in the prompt.
- **Perplexity** named "mcpemails" for question 2 (iCloud or Yahoo).
- **Gemini** named no email MCP vendor; it pointed to Zapier MCP.

Database (queries (b) and (c) in the scoreboard file; weeks start Monday):

| week of | chatgpt-source signups | of which landed on /connect/* | workspaces adding their first ChatGPT OAuth key |
|---|---|---|---|
| 2026-09-28 | 38 | 20 | 46 |
| 2026-10-05 | 24 | 7 | 58 |
| 2026-10-12 | 17 | 4 | 65 |

Reading: ChatGPT as a client keeps growing (installs come mostly from users who found us elsewhere), while ChatGPT as a referrer is shrinking, and the whole drop is in /connect/* provider pages. That is the citation loss this panel tracks.

## Targets, by 2026-11-30

- 30 or more chatgpt-source signups per week (query (a) or (b)).
- 12 or more of those landing on /connect/* per week (query (b)).
- At least 3 of the 6 core unbranded questions (1 to 6) naming us in ChatGPT.

## Weekly routine

1. Run the 16 questions in all four engines and log the rows.
2. Run the scoreboard queries (the file header explains how to run one at a time) and copy the latest full week into the log next to the panel results. Keep weekly numbers in the log; this file holds only the baseline and the targets.
3. Compare with last week: which questions gained or lost us, which of our URLs got cited, and whether /connect/* signups moved with them.

## Spot check, 2026-11-11

Single answers, run by hand, not a full panel run:

- **Google AI Mode**, "how to connect yahoo mail to claude": named us and cited /connect/yahoo first, alongside Fluxmail, MailMCP, Nylas CLI and a GitHub Yahoo server.
- **Google AI Mode**, "connect icloud mail to chatgpt": only OpenAI's own iCloud Mail plugin (launched 2026-10-27, every plan). Question 1 is likely to stop naming any third party.
- **Gemini** (temporary chat), question 13: did not name us; named mailmcp, Mailbox MCP, Mailopoly and Mailspring.
