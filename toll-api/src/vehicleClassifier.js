'use strict';
/**
 * LLM VEHICLE CLASSIFIER
 *
 * Takes freeform operator text ("21 seater tempo, AC") and classifies it
 * against the REAL, sourced vehicle_types table — not by letting the LLM
 * invent a category from its own training data. The prompt is built with
 * the actual DB rows as the only allowed answers, and the response is
 * validated against that same table before being trusted.
 *
 * Why an LLM here at all, instead of just the deterministic classifyBySeats()
 * fallback: operators describe vehicles inconsistently ("26 seater tempo",
 * "Force Traveller full size", "chhoti bus"), and a regex table can't cover
 * every phrasing an operator will actually type. The LLM's job is narrow —
 * map messy text to one of a FIXED set of real rows — not to reason freely
 * about vehicles.
 */
const { listVehicleTypes } = require('./evidence');

/** Builds the grounding prompt. Exported separately from the actual API call
    so this can be tested without needing a live Gemini key - the prompt
    construction is the part that determines correctness, not the network call. */
function buildClassificationPrompt(operatorText) {
  const types = listVehicleTypes();
  const catalogue = types.map((t) => (
    `- id: "${t.id}" | ${t.display_name} | seats ${t.seats_min}-${t.seats_max} | ` +
    `${t.axles} axle(s)` +
    (t.gvw_kg_max ? ` | GVW up to ${t.gvw_kg_max}kg` : '') +
    ` | NHAI class: ${t.nhai_official_name} (${t.toll_multiplier_of_car}x car rate)`
  )).join('\n');

  return `You are classifying a vehicle description from an Indian bus/tempo operator into ONE of the fixed vehicle types below. You must not invent a new type or guess specs beyond what is listed.

VEHICLE CATALOGUE (the only valid answers):
${catalogue}

OPERATOR'S TEXT: "${operatorText}"

Respond with ONLY a JSON object, no other text:
{"vehicle_type_id": "<one of the ids above, or null if genuinely none fit>", "confidence": "high"|"medium"|"low", "reason": "<one short sentence>"}

Rules:
- If the text mentions a seat count, that count MUST fall within the matched type's seat range.
- If nothing in the catalogue plausibly fits, return vehicle_type_id: null rather than forcing a match.
- Do not use any vehicle knowledge outside this catalogue - if the text mentions a vehicle not listed (e.g. a truck), return null.`;
}

/** Validates an LLM response against the real table - the actual safety net.
    Even if the model hallucinates an id or malforms JSON, this catches it
    before the classification is ever used to pick a toll rate. */
function validateClassificationResponse(rawResponseText) {
  let parsed;
  try {
    const jsonMatch = rawResponseText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawResponseText);
  } catch (e) {
    return { ok: false, error: 'LLM response was not valid JSON', raw: rawResponseText };
  }
  if (parsed.vehicle_type_id === null) {
    return { ok: true, matched: null, confidence: parsed.confidence || 'low', reason: parsed.reason || '' };
  }
  const types = listVehicleTypes();
  const match = types.find((t) => t.id === parsed.vehicle_type_id);
  if (!match) {
    // The model returned an id that doesn't exist in our real table - reject,
    // do not guess what it meant. This is the case that actually matters.
    return { ok: false, error: `LLM returned unknown vehicle_type_id "${parsed.vehicle_type_id}" - not in our sourced catalogue`, raw: rawResponseText };
  }
  return { ok: true, matched: match, confidence: parsed.confidence || 'medium', reason: parsed.reason || '' };
}

module.exports = { buildClassificationPrompt, validateClassificationResponse };
