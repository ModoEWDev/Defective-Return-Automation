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
    default:
      return 'We ran into an issue processing your claim. Please contact customer relations for help.';
  }
}

module.exports = { draftCustomerMessage };
