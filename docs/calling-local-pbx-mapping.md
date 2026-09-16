# Local PBX Calling Integration Mapping

This integration is provider-neutral inside ConfirmX and is configured with
`LOCAL_PBX_*` environment variables. The implemented adapter targets the
publicly documented local-PBX REST shape with:

- Bearer-token authentication.
- Per-merchant provider customer IDs.
- Extension provisioning.
- Inbound route creation.
- Click-to-call originate.
- CDR polling for status synchronization.

## Provider Configuration

ConfirmX field | Provider field
--- | ---
`CallingProviderAccount.providerCustomerId` | `{customerId}` path parameter
`CallingProviderAccount.providerKey` | `LOCAL_PBX_PROVIDER_KEY`, default `local_pbx`
`LOCAL_PBX_BASE_URL` | API base URL including version path
`LOCAL_PBX_API_TOKEN` | Bearer token

No provider API token is stored on a merchant record.

## Extensions

ConfirmX field | Provider request
--- | ---
`CallingExtension.extension` | `POST /telephony/customers/{customerId}/extensions` body `extension`
SIP password input | same request body `password`
WebRTC option | same request body `is_webrtc`
`CallingExtension.providerExtensionId` | extension number returned/stored after provisioning

SIP passwords are sent to the provider and are not persisted in ConfirmX.

## Business Numbers And Inbound Routing

ConfirmX field | Provider request
--- | ---
`CallingNumber.normalizedPhone` | inbound route `did_number`
route target type | inbound route `destination_type`
route target id | inbound route `destination_id`

Implemented endpoint:

`POST /telephony/customers/{customerId}/inbound-routes`

Supported provider destination types are `ivr`, `extension`, `queue`, and
`time_condition`.

## Outbound Masking

The public click-to-call endpoint documents only:

- `extension`
- `phone_number`

There is no documented per-call caller-ID or mask field. ConfirmX therefore
does not send a caller-ID override. Outbound masking must be configured in the
PBX/provider account through the tenant's PBX number, extension display-number
setting, outbound route, or SIP trunk configuration.

ConfirmX stores the business number on `CallSession.businessNumberId` for
ownership/audit context, but the current adapter does not assume the provider
accepts that number as a per-call mask.

## Outbound Calls

ConfirmX field | Provider request
--- | ---
`CallingExtension.extension` | `POST /customers/{customerId}/calls/originate` body `extension`
normalized customer phone | same request body `phone_number`
provider response call id | `CallSession.providerCallId`

The provider first rings the agent extension, then dials the customer after the
agent answers.

## Call Events And Status Synchronization

Real-time provider call webhooks are not part of the public verified contract
for this adapter. ConfirmX synchronizes provider status by polling CDR:

`GET /customers/{customerId}/cdr`

CDR record field | ConfirmX field
--- | ---
`call_id` / `uniqueid` / `id` | `CallSession.providerCallId`
`disposition=ANSWERED` | terminal `completed`
`disposition=NO ANSWER` | terminal `missed`
`disposition=BUSY` / `FAILED` / other | terminal `failed`
`billsec` / `duration` | `CallSession.durationSeconds`

Every CDR-derived event uses idempotency key:

`cdr:{providerCallId}`

Repeated CDR syncs therefore do not duplicate call events, status transitions,
or usage billing.

## Current Limits

- No SIP/WebRTC implementation in ConfirmX.
- No provider-specific webhook endpoint.
- No IVR/queue provisioning beyond inbound route targeting.
- No call recording ingestion.
- No per-call masking override because the verified public API does not expose
  one.
