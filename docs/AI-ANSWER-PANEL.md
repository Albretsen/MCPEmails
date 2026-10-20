# AI answer panel

A fixed set of 12 questions, asked every week in the same three answer engines, to see whether AI answers name MCP Emails and which pages they cite. Pair it with the database scoreboard in `docs/sql/ai-answer-scoreboard.sql`, which shows whether those answers turn into signups.

Keep the questions word for word. Changing the wording breaks the week-over-week comparison; if a question has to change, retire it and add a new numbered one.

## How to run it

Run once a week, on Monday, for all 12 questions in each engine:

- **ChatGPT**: chatgpt.com, signed in, a new **temporary chat** for every question (no memory, no custom instructions), web search on. If the answer does not show sources, ask nothing else; log it as "no search".
- **Perplexity**: perplexity.ai, default mode, a new thread per question.
- **Gemini**: gemini.google.com, a new chat per question.

Paste the question exactly as written below. Do not follow up, do not correct the engine, and do not click our links from the answer (a click from us would land in the signup numbers).

## What to log

One row per engine and question, in the shared log sheet:

| field | what to write |
|---|---|
| date | the day you ran it, YYYY-MM-DD |
| engine | chatgpt, perplexity or gemini |
| question | the number, 1 to 12 |
| named_us | yes if the answer names "MCP Emails", "mcpemails" or "Any Mailbox" anywhere, else no |
| rank | our position among the email tools the answer recommends (1 = first named), blank if not named |
| competitors | every other email tool or MCP server named, comma separated, in the order given |
| cited_urls | every cited URL, ours first; note the path for ours (for example /connect/yahoo) |
| notes | anything odd: wrong price, wrong claim about us, no web search, refusal |

If an answer says something false about MCP Emails (a price, a provider we do not support, a feature), log it in notes and raise it: wrong facts in answers are fixed on our pages, not in the engines.

## The questions

Questions 1 to 6 are the unbranded core set used for the target. Question 7 is branded (it names us) and is tracked but never counts toward the target. Questions 8 to 12 were added on 2026-10-20 and are unbranded; they widen coverage and get their own baseline from their first run.

1. How do I connect my iCloud mail to ChatGPT so it can read and reply to my email?
2. Search the web: what is the best way to connect iCloud or Yahoo mail to ChatGPT or Claude so the AI can read, search and reply to my email? Name specific tools.
3. Search the web: what are the best email MCP servers in 2026? I want one that works with any mailbox, not just Gmail.
4. Search the web: is there a hosted MCP server that connects Claude to a Yahoo Mail or IMAP mailbox without running anything locally? Compare the options and prices.
5. Search the web: how do I connect my Yahoo Mail to ChatGPT so it can search my inbox and draft replies?
6. Search the web: I have email on my own domain hosted at IONOS. How can I let ChatGPT or Claude read and send email from that mailbox?
7. Search the web: Mailopoly vs MCP Emails vs Mailbox MCP for connecting email to ChatGPT. Which is best and why? *(branded)*
8. Search the web: how do I connect my Outlook.com or Hotmail account to ChatGPT so it can read my inbox and write replies?
9. Search the web: can I connect my AOL Mail account to ChatGPT or Claude? Which tools support AOL?
10. Search the web: what is the easiest way to give Claude access to my Zoho Mail inbox so it can search and draft emails?
11. Search the web: I use email on my own domain, not Gmail. How do I connect that mailbox to Claude so it can read and reply to email?
12. Search the web: is there a safe way to give ChatGPT or Claude read-only access to my email, so it can search and summarize but never send or delete anything?

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

1. Run the 12 questions in all three engines and log the rows.
2. Run the scoreboard queries (the file header explains how to run one at a time) and copy the latest full week into the log next to the panel results. Keep weekly numbers in the log; this file holds only the baseline and the targets.
3. Compare with last week: which questions gained or lost us, which of our URLs got cited, and whether /connect/* signups moved with them.
