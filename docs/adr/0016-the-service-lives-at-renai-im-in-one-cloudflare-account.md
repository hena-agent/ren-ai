---
status: accepted
---

# The service lives at renai.im in one Cloudflare account

Ren AI's hostnames were split across two domains in two Cloudflare accounts. Admin and Discovery were Workers under ambivalent.dev in the Ambivalent Co. account. The application, the Messages Mac, OpenCode and Fleet were tunnels under hena.dev in a different account. The service now has its own domain, renai.im, registered in the Ambivalent Co. account. Cloudflare routes a tunnel only to DNS records in the tunnel's own account, and a Worker's custom domain must be in the Worker's account. So every hostname that moves is provisioned again in Ambivalent Co.: a DNS rename alone is not enough.

## Decision

| Hostname           | Serves                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `renai.im`         | Discovery (`apps/discovery`, Worker `persona-discovery`)            |
| `www.renai.im`     | A redirect to `renai.im`                                            |
| `admin.renai.im`   | Admin (`apps/admin`, Worker `persona-admin`)                        |
| `api-app.renai.im` | The stateful application (`apps/api`, `@ren-ai/api-app`) on Workers |
| `api-msg.renai.im` | The DB-free Mac executor (`apps/api-msg`, `@ren-ai/api-msg`)        |
| `imsg.renai.im`    | The Messages Mac gateway (`apps/imsg`)                              |
| `oc.renai.im`      | OpenCode and its native operator interface                          |

- **Fleet stays at `fleet.hena.dev`.** The Mac's MDM enrollment contains Fleet's URL. Changing it means re-enrolling the production Messages Mac, which loses its Full Disk Access and Accessibility profiles until they are delivered again. Only the operator ever sees this address. Fleet's tunnel is the only part of the service left in the hena.dev account.
- **The service handle is `hi@renai.im`.** It is also the privacy contact in Discovery's consent text. `hi@hena.dev` leaves iMessage once no conversation uses it.
- **Old hostnames retire without redirects**, as `msg.hena.dev` did. The Mac's LaunchAgents and permission profiles move from the `dev.hena.*` namespace to `im.renai.*`.
- **One account, one CI token.** A single Ambivalent Co. token deploys every Worker. The Turnstile widget for `renai.im` lives in the same account.

This revises the hostnames in ADR-0010 and ADR-0014. Their decisions are otherwise unchanged. The API Worker deploys from CI after quality gates. Its initial staging is bootstrap-only; intake moves only after the old application is paused and its state has been explicitly imported and verified. The Mac executor deploys from the current Mac using the attested `main` artifact, after one-time operator provisioning of its process, tunnel and private environment.
