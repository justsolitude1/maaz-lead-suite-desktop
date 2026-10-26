// Local model used to draft outreach emails. Nothing leaves this machine:
// LM Studio serves an OpenAI-shaped API on localhost and we call it directly.
// No API keys, no cloud.
//
//   lms server start                                   (no GUI needed)
//   lms load qwen/qwen3-4b-2507 --gpu max -c 8192 --identifier email-writer
//
// `model` is the identifier LM Studio reports at GET /v1/models. Loading with
// --identifier pins that name so swapping the underlying model does not break
// this config.
export const LLM = {
  baseUrl: process.env.LLM_URL || 'http://127.0.0.1:1234/v1',
  model: process.env.LLM_MODEL || 'email-writer',
  temperature: 0.7,
  maxTokens: 700,
  // ~35 tok/s on a 4 GB card, so a 700-token draft is ~25s. The ceiling is
  // generous because the first call after a load also pays to read the model
  // off disk.
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 180000),
  promptFile: 'prompts/smykm.txt',
};

// What you are offering, and the proof you are allowed to cite. Same for every
// lead, so it lives here rather than being retyped per draft.
//
// Leave a field empty and drafting refuses rather than calling the model. That
// is deliberate: asked for a result it has not been given, the model invents
// one, and an invented client number in a cold email is the worst thing this
// tool could produce.
export const PITCH = {
  // One line, first person. "I help <who> <do what>."
  // Taken from Maaz's own Ella email - check it still reflects the offer.
  offer: 'I help therapists unlock new revenue through Instagram.',

  // One concrete, true client result. No rounding up.
  proof: 'one of my clients has grown to 50K followers, leading to online consultations, ebook sales and international workshop invitations.',

  // The objection this audience usually has. Optional.
  objection: '',

  signOff: 'Maaz',
};

export const pitchGaps = () => ['offer', 'proof'].filter((k) => !String(PITCH[k] || '').trim());
