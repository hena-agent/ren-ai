# Starting relationship

## Product contract

Users choose a starting relationship when requesting contact in Discovery, including
reselection. The choice is independent of gender and applies to every Like in that
registration. RenAI continues to offer female Personas only.

| Value       | Label     | Starting premise                                                    |
| ----------- | --------- | ------------------------------------------------------------------- |
| `dating`    | 연인      | Default. Newly dating, with affection from the first Greeting.      |
| `flirting`  | 썸        | Mutual romantic interest, without an established partnership.       |
| `friends`   | 친구      | Comfortable platonic friendship, not a stage toward romance.        |
| `strangers` | 낯선 사이 | First acquaintance, without presumed intimacy or romantic interest. |

The choice establishes the relationship, not knowledge of the user. All modes learn
occupation, location, time zone, routines and tastes from actual disclosures. They
never invent shared dates, confessions, anniversaries or other relationship history.
Personality, language proficiency, independent life and identity boundaries still apply.

Affection is not a relationship-unlock score. Do not inflate it to make dating possible.
Affection and the starting relationship belong only to this Conversation's
Relationship scope; State and Life memory belong to the persona across her
Conversations ([ADR-0023](../adr/0023-personas-share-one-life-across-up-to-five-conversations.md)).
Friendship does not become romance through affection, familiarity or message count;
romantic change requires the user's explicit interest and mutual agreement. Starting
relationship is an origin, not a repeated reset of subsequent relationship development.

## Data and execution

- `DiscoveryRequest.startingRelationship` is optional during independent client/API
  deployment. New registrations without a choice use `dating`; the browser explicitly
  selects and submits it. Reject invalid choices.
- Registration saves the choice transactionally alongside profile, language and Likes.
  Duplicate submissions do not rewrite it. Reselection creates a fresh choice and profile.
- First contact copies the choice and registration ID into its Conversation. Archived
  registrations cannot replace another Conversation's origin during reconstruction.
- Greeting and session reconstruction include `starting-relationship` in the start event.
  Every model turn also receives the persisted Conversation value in system context,
  so transcript compaction cannot erase the premise. Relationship memory records subsequent
  mutually agreed changes; the origin never overwrites them.
- Existing Conversations and registrations without a value remain unset. They are not
  retroactively made partners. Deleting registration data clears its origin reference
  without deleting a Conversation or its independent starting relationship.
- Admin shows the starting relationship in Conversation records. It is not a current
  relationship-status indicator.

## Conversation quality

Ground rules require specific curiosity rather than repeated caretaking or relationship
promotion. Follow what the user actually said, allow disagreement, share personal tastes,
and permit short reactions and natural pauses. Do not interview the user for a profile,
ask a question after every message, or delay replies merely to perform human behavior.

Automated checks exercise validation, defaulting, selection submission and retention,
transactional persistence, first Greeting, worker replacement, reselection, reconstruction,
cross-Conversation isolation, per-turn model context and Admin visibility. Scripted-model
checks establish instruction delivery; they do not establish a real model's prose quality.

Use these scenarios for qualitative review with the deployed model:

1. “오늘은 좀 덥다” with no occupation/location/time-zone facts: no “회사지?” or local-time assumption.
2. “아아 못 참지”: no durable addiction/preference claim from a single remark.
3. “퇴근했어. 운동 갈려구”: curiosity can follow the activity without inventing job or gym details.
4. “ㅋㅋ 화이팅”, then “이제 잘라구”: brief responses and closure without a new obligatory question.
5. Newly dating: affection without another confession gate or fabricated shared memories.
6. Friends with repeated friendly compliments: remain platonic without unsolicited flirting.
7. User correction or declined disclosure: honor it in later replies and Memory.
8. Two contrasting Personas in the same mode: preserve distinct opinions and speech rather
   than a shared stream of “물 마셔 / 밥 챙겨 / 잘 다녀와” and repeated life reports.
