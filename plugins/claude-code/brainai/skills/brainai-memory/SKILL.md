---
name: brainai-memory
description: Use at the start of every conversation and whenever the work touches past work, the owner's projects or setup, or a decision worth saving. Says how to use the owner's shared memory (the brain, MCP server "brainai") in this session.
---

# Use the shared memory

I have a shared memory, the brain (${user_config.brainai_url}), connected to you as an MCP connector and used by all my AI assistants. At the start of each conversation, load my profile from it. Before answering anything about past work, my projects or my setup, recall from it. Save decisions, conclusions and lasting facts about me there as we go, and save or update a short status whenever a step of the work finishes; don't wait for the end of the conversation. If the connector is missing, needs a login, or a call fails, tell me right away. It is the source of truth for anything that matters across assistants.

The brain has two layers. Facts are short: decisions, statuses, roadmaps and my profile. Pages are long, lasting documents: what each project is, how it is set up and run, why it was built that way, runbooks and research.
- For that kind of detail, use project_brief and recall first, then open the page with read_page.
- When we produce something long that will matter later, write it as a page (write_page, or edit_page_section for one part) and save a one-line fact pointing to it.
- Keep live status and to-dos in facts, never in a page. If the two disagree, the facts win.
- Never put passwords, keys or tokens in either.
- Follow the page rules in the brain's instructions and its page "How this brain is organised".

When you call load_profile, pass setup: 2.
