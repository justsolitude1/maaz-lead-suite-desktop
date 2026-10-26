# Drafting emails with a local model

Leads King can draft SMYKM outreach emails using a model running on your own
machine through [LM Studio](https://lmstudio.ai). No API keys, no cloud, and
nothing about a lead leaves the network.

It drafts only. Nothing here sends anything.

---

## Setup on the machine with the GPU

Install LM Studio, then from any terminal:

```
lms server start
lms load qwen/qwen3-4b-2507 --gpu max -c 8192 --identifier email-writer
```

`--identifier email-writer` pins the name the API reports, so swapping the
underlying model later does not break the config.

Check it:

```
curl http://127.0.0.1:1234/v1/models
```

### Hardware notes

Measured on a Radeon RX 5500 XT (4 GB) with 12 GB RAM:

| | |
|---|---|
| Model on disk | 2.50 GB (Q4_K_M) |
| In VRAM | 2.33 GiB |
| Throughput | ~35 tok/s |
| One draft | 20–40 s |

AMD RDNA1 cards (gfx1012) are **not** supported by ROCm, so Ollama falls back
to CPU at roughly 4 tok/s. LM Studio ships a Vulkan runtime that uses the GPU
properly — check `lms runtime ls` shows a `vulkan` engine selected.

Context is capped at 8192 deliberately. On 4 GB, 16k needs 3.54 GiB and leaves
nothing for the desktop; 32k overflows into system RAM.

---

## Configuration

`llm-config.mjs` holds everything.

| Setting | Default | Override |
|---|---|---|
| Endpoint | `http://127.0.0.1:1234/v1` | `LLM_URL` |
| Model | `email-writer` | `LLM_MODEL` |
| Timeout | 180000 ms | `LLM_TIMEOUT_MS` |

The same file holds `PITCH` — your offer, your proof, the usual objection.
These are the same for every lead, so they live in config rather than being
retyped. **Leave `offer` or `proof` empty and drafting refuses**, by design:
asked for a result it has not been given, the model invents one, and an
invented client number in a cold email is the worst thing this tool could
produce.

The prompt is `prompts/smykm.txt`, re-read on every draft, so you can edit it
and retry without restarting.

---

## Using it

Open the **Therapist emails** tab. Each research row with an identified
practitioner and some prose about them gets a **Draft an email to …** panel:

1. It shows the text the model will work from.
2. You type your genuine tie — why that actually means something to you.
3. Draft email.

The tie is required. There is no way to make the model produce one honestly,
and it will invent one if allowed.

### Why some rows have no button

```
node check-draftable.mjs
```

reports how many saved rows have enough to go on. As of the last run:

```
rows:            9111
draftable:       696  (7.6%)
no person name:  7357  (80.7%)
no prose at all: 600  (6.6%)
too thin:        458  (5.0%)
```

The limit is research coverage, not the model. SMYKM needs a person and
something they wrote; a row with neither gets no panel.

---

## Guards, and why they exist

Both were added after watching the failure happen, not as precautions.

**Thin material is refused before the model is called.** Fed the email
handoff's `publicContextExcerpt` — a contact scrape: name, credentials,
address — the model wrote *"I saw you use sand trays and dream work in the
room"*, lifted from the example in the prompt, about a therapist who does
nothing of the kind. Four runs out of four. Contact scrapes, credential
blobs and bare nav bars now return HTTP 422 with the reason.

**Scraped nav bars are stripped.** Left in, the model built its hook out of
the menu — *"your site gets people to the point where they're ready to book
an appointment"* — instead of the bio two lines below it. After stripping,
the same row opens on *"helping adults through anxiety and life transitions"*.

A third fix was to the prompt: a subject line that read as a finished sentence
made the model stop before writing the email at all, three runs in four.

---

## Sharing one machine's model with another PC

Only worth it when the second PC has no usable GPU. You are sharing one card:
two people drafting at once each wait longer, not less.

### On the machine with the GPU

Bind LM Studio to the network:

```
lms server start --bind 0.0.0.0
```

Then, from an **admin** PowerShell:

```
powershell -ExecutionPolicy Bypass -File setup-lan-sharing.ps1
```

That sets your network profile to Private and adds an inbound rule for TCP
1234 limited to `LocalSubnet`. It is safe to run twice and prints the exact
URL the other PC needs.

> LM Studio's API has **no authentication**. Anything that can reach port 1234
> can generate on your GPU. `-RemoteAddress LocalSubnet` keeps that to your own
> subnet — do not widen it, and do not do this on a network you don't control.

### On the other PC

Test the hop before touching the app:

```
curl.exe --max-time 10 http://<gpu-machine-ip>:1234/v1/models
```

A model list back means the network side works. Then set the variable
permanently — a `$env:` assignment only lasts for that one window and an app
launched from the Start menu will not see it:

```
[Environment]::SetEnvironmentVariable('LLM_URL','http://<gpu-machine-ip>:1234/v1','User')
```

Fully quit Maaz Lead Suite, including the tray icon, and reopen it. The
Electron shell spawns the server with `{ ...process.env, ...overrides }`, so
the variable is inherited.

Confirm it took by opening `http://127.0.0.1:4173/api/llm` on that PC. If it
reports `up: true` and `loaded: true` while that machine runs no LM Studio of
its own, it is reaching across.

Only the model is shared. `LEADKING_HOST` stays `127.0.0.1`, so each machine's
CRM remains private to it.

### Undoing it

```
Remove-NetFirewallRule -DisplayName 'LM Studio (LAN)'
lms server start
```

`lms server start` without `--bind` returns it to localhost only.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No LM Studio at …` | Server not running. `lms server start`. |
| `up: true, loaded: false` | Server up, no model in memory. `lms load …`. |
| `Nothing to work from yet: …` | A slot is empty. The message names which. |
| `Not enough to go on: …` | The research is a contact scrape or a nav bar. |
| Draft takes >60 s | First call after a load also reads the model off disk. |
| curl from other PC times out | Firewall rule missing, or the network is still Public. |
| Variable ignored on other PC | Set with `$env:` instead of `SetEnvironmentVariable`, or the app wasn't fully restarted. |
| App shows zero leads | Running `node server.mjs` directly points at `LeadKingReplica`. The app sets `LEADKING_DATA_DIR` to `MaazLeadSuite\LeadKing`. |
