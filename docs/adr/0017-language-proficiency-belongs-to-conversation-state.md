---
status: accepted
---

# Language proficiency belongs to each Conversation's State

A Persona can learn through a user's explanations and shared practice. Keep native and primary languages in the Persona's fixed language background, current proficiency in Conversation State, and learned expressions and experiences in Memory. Native is an identity attribute, not a promotion above fluent. This extends [ADR-0013](0013-conversations-own-state-and-two-tier-memory.md): initial proficiency is operator-approved Catalog data, while growth belongs only to that Conversation and survives Catalog updates and restarts.

Discovery shows initial proficiency, never another user's learning. Its Korean, English and Japanese display settings translate controls and consent notices but leave public profile writing unchanged. Preferred conversation language is stored independently of display/consent language and guides the first Greeting only within the Persona's actual proficiency.
