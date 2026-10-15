const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-5-5'; // short, templated customer messages don't need a larger model

async function draftCustomerMessage(result, context) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: buildPrompt(result) }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return text || fallbackMessage(result);
  } catch (err) {
    // The decision has already been made and, if approved, the credit memo
    // already posted — a wording failure here should never block that.
    context.error('draftCustomerMessage failed, using fallback message', err);
    return fallbackMessage(result);
  }
}

function buildPrompt(result) {
  const base =
    'Write a short, warm, professional message (2-3 sentences) to an optical practice customer ' +
    'about the outcome of a warranty claim. Do not mention internal systems, SKUs, account numbers, ' +
    'or policy names.';

  switch (result.outcome) {
    case 'approved':
      return `${base}\n\nThe claim was approved and a credit has been issued to their account.`;
    case 'offer':
      return (
        `${base}\n\nThe purchase is outside the warranty window, so instead of a credit, they're ` +
        'being offered a replacement frame at 50% off wholesale price. Tell them to contact customer ' +
        "relations if they'd like to take advantage of the offer. Do not state a dollar amount."
      );
    case 'escalate':
      return (
        `${base}\n\nThis claim needs a quick look from the team before a decision can be made. Let ` +
        'them know someone will follow up, without saying why or giving a timeframe beyond "shortly."'
      );
    case 'invalid':
      return (
        `${base}\n\nTell them exactly this, rephrased naturally: "${result.details.reason}" ` +
        'Do not mention escalation, a team, or anyone following up — just restate this plainly.'
      );
    default:
      return `${base}\n\nSomething went wrong processing this claim. Ask them to contact customer relations directly.`;
  }
}

function fallbackMessage(result) {
  switch (result.outcome) {
    case 'approved':
      return 'Good news — your warranty claim has been approved and a credit has been issued to your account.';
    case 'offer':
      return (
        "This purchase falls outside our warranty window, but we'd like to offer a replacement frame " +
        'at 50% off wholesale. Please contact customer relations if you\'d like to take us up on that.'
      );
    case 'escalate':
      return 'Thanks for submitting your claim — our team needs to take a closer look, and someone will follow up with you shortly.';
    case 'invalid':
      return result.details.reason;
    default:
      return 'We ran into an issue processing your claim. Please contact customer relations for help.';
  }
}

/**
 * Fallback for when literal substring matching finds zero or multiple
 * candidates. Real NetSuite data often abbreviates colors (GRN for green)
 * or embeds style numbers differently than a customer would type them, so
 * this asks Claude to use judgment on the same small, already-valid set of
 * line items — not an open-ended guess. Only returns a match when Claude is
 * confident; anything else should still escalate, same as before.
 */
async function matchItemWithClaude(lineItems, styleName, color, description, context) {
  const itemList = lineItems
    .map(
      (item, i) =>
        `${i}: style "${item.style}", color "${item.color}", type "${item.productType}" (SKU "${item.sku}")`
    )
    .join('\n');

  const prompt =
    `A customer described a frame as style "${styleName || ''}" and color "${color || ''}", ` +
    `and described their issue as: "${description || ''}". ` +
    `Here are the items on their invoice, with their actual recorded style, color, and product ` +
    `type:\n${itemList}\n\n` +
    'Which one (if any) are they most likely describing? Account for minor typos, abbreviations, ' +
    'or the customer giving only part of a multi-word color (e.g. "pink" for "Crystal Pink"). ' +
    'Some items share identical style and color but differ in product type — e.g. "OPTICAL" is the ' +
    'frame itself, "CLIP" is its separate magnetic sun clip. If the style/color alone can\'t tell two ' +
    'such items apart, use the product type together with whatever the issue description says (e.g. ' +
    'mentioning "the clip" or "sun clip" points at the CLIP-type item, not the frame). ' +
    'Respond with ONLY a JSON object, no other text: ' +
    '{"matchIndex": <number or null>, "confidence": "high" | "medium" | "low"}. ' +
    'Only use "high" confidence if you are genuinely sure — this decision affects a real credit.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) throw new Error(`Claude API error: ${response.status}`);

    const data = await response.json();
    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    const parsed = JSON.parse(text);
    if (parsed.confidence === 'high' && typeof parsed.matchIndex === 'number') {
      return lineItems[parsed.matchIndex] || null;
    }
    return null;
  } catch (err) {
    // If this fails for any reason (bad JSON back, network issue), treat it
    // the same as "no confident match" — escalate rather than guess.
    context.error('matchItemWithClaude failed, treating as no match', err);
    return null;
  }
}

/**
 * Confirms the uploaded photo actually shows eyewear hardware (a frame,
 * sunglasses, a magnetic clip, or a clearly identifiable part of one) —
 * not a true defect judgment (that's a much harder, less reliable call,
 * deliberately not automated here), just basic object recognition: is
 * this even a picture of the right kind of thing at all.
 *
 * Fails OPEN on any error (network issue, bad JSON back, etc.) — a
 * transient problem with this check should never block a legitimate
 * claim; it only ever blocks on an actual confident "no."
 */
async function isPhotoOfEyewear(photoBase64, photoMimeType, context) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: photoMimeType || 'image/jpeg',
                  data: photoBase64,
                },
              },
              {
                type: 'text',
                text:
                  'Does this photo clearly show an eyeglass frame, sunglasses frame, a magnetic ' +
                  'clip-on sun clip, or a clearly identifiable part of one (temple, hinge, lens, ' +
                  'nosepiece, etc.)? Say false if it shows something unrelated, is blank/unreadable, ' +
                  'or you genuinely cannot tell. Respond with ONLY a JSON object, no other text: ' +
                  '{"isEyewear": true or false}',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) throw new Error(`Claude API error: ${response.status}`);

    const data = await response.json();
    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    const parsed = JSON.parse(text);
    return { isEyewear: parsed.isEyewear !== false, errored: false };
  } catch (err) {
    context.error('isPhotoOfEyewear check failed, allowing claim through', err);
    // TEMPORARY DEBUG — remove once confirmed working.
    return { isEyewear: true, errored: true, debugMessage: err.message };
  }
}

module.exports = { draftCustomerMessage, matchItemWithClaude, isPhotoOfEyewear };
