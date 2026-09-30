---
status: accepted
---

# Separate the Messages Mac from OpenCode

The Mac-native service should own only Messages/imsg and the local transport needed to receive and send messages. Move AI orchestration, conversation routing, and OpenCode session management into portable Docker services, using the existing OpenCode instance at `oc.hena.dev`, so either deployment can be moved to another host independently. This decision supersedes ADR-0004's embedded-runtime and read-only-viewer choices and revises ADR-0006's local persona-only backup assumptions.

## Migration requirements

- Preserve existing conversation memory and state across the switch.
- A short planned pause in replies is acceptable if incoming messages are retained and processed afterward.
- Automate provisioning, including macOS permission setup, and document how to move each host.
- The Mac should need no OpenCode configuration or credentials.
- Use OpenCode's native operator interface and features at `oc.hena.dev`. Delete the custom read-only viewer and its API restrictions rather than recreating them on the new host. This revises ADR-0004's restriction that nothing typed in the web UI reaches a conversation.
- Retain ADR-0001's conversation-bound persona tool policy: personas use only `send`, `read`, `react`, and `wait`. Removing the viewer restrictions does not grant personas general-purpose OpenCode tools.
- Use publicly reachable HTTPS endpoints with authorization for service communication. Do not introduce a Tailscale dependency.
- Do not depend on paid external third-party services. MDM selection must satisfy this constraint while supporting automated permissions.

## Agreed service boundaries

- **Mac messaging service:** imsg, Messages UI automation for existing typing/read/reaction behavior, history and delivery-status queries, and attachment handling including macOS image conversion. It has no persona or OpenCode responsibilities.
- **Portable application service:** onboarding, conversation-to-session bindings, intake progress and deduplication, delivery records and reconciliation, resets, and follow-up scheduling. It owns application state independently of OpenCode's storage.
- **Docker OpenCode at `oc.hena.dev`:** persona sessions and memory, with an installed persona plugin for conversation-bound tools and model hooks. The plugin communicates with the application service over a network API rather than sharing its SQLite file or process-local closures.

Use self-hosted Fleet Free for MDM-managed permission profiles, with Fleet, MySQL, and Redis deployed in Docker. MDM enrollment is an agreed prerequisite for automated Mac permission setup. Preserve the existing messaging capabilities when moving them behind the Mac service boundary.

The migration target is the existing local Docker OpenCode instance at `oc.hena.dev`. Move the persona runtime into that instance now; moving Docker to another physical machine is a future operation. The Mac-native messaging service and Docker services must be independent deployments even while they share the current physical Mac.

Persona sessions use a dedicated OpenCode location and persona-specific configuration. Exclude unrelated inherited global plugins, such as prompt translation or Discord forwarding, from that location. Other OpenCode projects keep their own configuration. Location scoping does not constitute a separate security sandbox; deployed policy and plugin behavior still require verification.

Failed-turn recovery will use supported OpenCode APIs rather than the current private resume operation. Changes to internal retry-turn semantics are acceptable, while message deduplication, delivery reconciliation, and handling of uncertain sends must be preserved.

An absent Messages row does not prove an uncertain send failed, even after a grace period. Later sends remain fenced until Messages supplies a definitive outcome; a disconnected request may still finish on the Mac.

Reuse Cloudflare Tunnel for public HTTPS ingress. The messaging and application APIs enforce authorization using dedicated service credentials; they do not rely on a paid Cloudflare Access subscription. Endpoint URLs and credentials are deployment configuration so the services can move independently. The Mac receives only messaging-service credentials, never OpenCode credentials.

## Deployment and relocation

| Public address     | Responsibility                                    |
| ------------------ | ------------------------------------------------- |
| `imsg.hena.dev`    | Mac messaging API                                 |
| `api-msg.hena.dev` | Portable application service                      |
| `oc.hena.dev`      | Existing Docker OpenCode and its native interface |
| `fleet.hena.dev`   | Self-hosted Fleet management                      |

Deliver separate setup, export, and restore procedures for the Mac messaging service and Docker services. Preserve application state, OpenCode memory, service credentials, and Fleet certificates. Keep configuration and persistent data portable, rather than depending on the current Mac's username, checkout paths, or Keychain entries. Apple sign-in, initial Fleet enrollment, and annual Apple push-certificate renewal are documented attended steps.

For the initial cutover, pause intake and scheduling, settle or record outstanding work, and snapshot the application and embedded OpenCode state. Import active and retained persona sessions into the existing Docker OpenCode without overwriting its existing sessions; transfer the application-owned bindings and pending-work records separately. Reconcile Messages history and uncertain sends before resuming through the new services, then retire the embedded runtime, read-only viewer, and viewer-only asset process.

`BOOTSTRAP_ONLY=true` serves the authenticated persona catalog during import while rejecting messaging actions and leaving intake, scheduling, and recovery stopped. Restart in normal mode after restoring state; restored pending inbox work is activated through supported OpenCode APIs with stable recovery-input IDs.

The archive also records stable recovery input and a tool-attempt journal for a promoted turn whose unfinished assistant is omitted by native export. Restore imports completed and uncertain effects as visible history before admitting queued inputs. Reconciliation failures retry the complete event-consumption loop, retaining the connection alert until a durable-state scan succeeds.

For a replacement Mac, bootstrap the messaging service, sign into the service's Apple Account, enroll in Fleet, and verify permissions and Messages history before switching traffic. For replacement Docker hosts, restore the relevant service data and credentials, verify the integration, and switch the stable public addresses to the new deployment. The procedures must verify the restored service before traffic moves and account for messages received during the pause.

## Acceptance

- The Mac-native messaging service starts and operates without OpenCode dependencies, configuration, or credentials.
- The application and persona runtime use network APIs rather than shared SQLite files, Mac filesystem paths, or process-local callbacks across service boundaries.
- Existing messaging capabilities, conversation memory, retained reset sessions, and pending-message recovery survive the cutover.
- OpenCode's native operator features work at `oc.hena.dev`; personas retain their conversation-bound tool policy.
- A replacement Mac can use the existing Docker services, and replacement Docker hosts can use the existing Mac messaging service.
- Fleet delivers the required permission profiles after enrollment, and the setup verifies the actual service's permission attribution.

## Baseline inspected on 2026-09-30

The repository's port 8447 deployment is a read-only viewer of the application's embedded OpenCode runtime, not a standalone OpenCode API. The application also owns onboarding, scheduling, send reconciliation, and its own SQLite state. Separating these responsibilities requires an explicit network contract rather than a URL substitution.

Read-only local inspection identified this execution host as the deployed `chris-mini` Mac (macOS 26.6.2), with the application and viewer listeners running. The existing `oc.hena.dev` Docker deployment also runs on this Mac through OrbStack, rather than on a separate physical server. Its Compose source is `/Users/chris/git/hena-agent/oc.hena.dev/docker-compose.yml`; the upstream image is `ghcr.io/anomalyco/opencode:2.0.19`. Cloudflare Tunnel routes through a cookie-auth proxy to OpenCode, with no published host ports. Persistent volumes hold OpenCode's home and proxy data; the read-only `/srv/ren-ai` persona-location mount is currently empty.

Apple's supported unattended privacy-permission grants require [MDM-delivered PPPC policy](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web). A local administrator script cannot replace that policy, and Apple Account sign-in remains attended. Local enrollment inspection reports no MDM or Automated Device Enrollment on this Mac.

[Fleet Free](https://fleetdm.com/pricing) provides self-hosting, manual device enrollment, and custom configuration profiles without Premium. Its [Apple certificate setup](https://fleetdm.com/guides/apple-mdm-setup) uses a free Fleet-hosted CSR signer and Apple's push certificate service, requires organization details, and entails attended annual APNs certificate renewal. Successful certificate onboarding still requires verification; automated permission grants do not imply unattended Apple sign-in, initial enrollment, or certificate renewal.

The documented [OpenCode V2 client](https://opencode.ai/v2/docs/build/client) and [server-side plugin API](https://opencode.ai/v2/docs/build/plugins) support the agreed service boundaries, subject to deployed-version verification. Plugins can be scoped to a persona location, but inherited global plugins require explicit review; location scoping alone does not isolate personas from them.

The current application's exact failed-turn resume operation uses an internal OpenCode service without an equivalent documented public endpoint. It must be replaced as part of the agreed public-API recovery design. Event subscriptions are live-only, so reconnection must reconcile durable state.

Experimental session export/import can preserve settled history and session IDs while rebinding the destination location, but does not transfer all pending execution state. Migration must account separately for pending work, retained sessions, application state, and attachments, with fidelity verified against the deployed version.

## Implementation verification

Docker deployment metadata, configuration, storage mounts, and local inspection access have been verified. Authenticated API behavior, installed-plugin effects, and session-transfer fidelity still require verification against that deployment before promising a concrete migration procedure.

Verify the public hostname routes, machine-to-machine OpenCode authentication through the existing cookie-auth proxy, public-API recovery semantics, attachment transfer, and pending-work reconciliation before cutover. Verify Fleet certificate onboarding and PPPC delivery from the Mac service's actual launch context. These are implementation checks against the agreed design, not assumptions that the current deployments already satisfy it.
