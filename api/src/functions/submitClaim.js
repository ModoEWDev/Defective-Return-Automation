const { app } = require('@azure/functions');
const { evaluateClaim } = require('../lib/rules');
const { draftCustomerMessage } = require('../lib/claude');

const ALWAYS_REQUIRED_FIELDS = ['accountNumber', 'description', 'photoBase64'];
const MAX_ITEMS_PER_SUBMISSION = 3;

app.http('submitClaim', {
  methods: ['POST'],
  authLevel: 'anonymous', // public endpoint — Static Web Apps serves this at /api/claims
  route: 'claims',
  handler: async (request, context) => {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return { status: 400, jsonBody: { error: 'Invalid JSON body.' } };
    }

    const missing = ALWAYS_REQUIRED_FIELDS.filter((field) => !body[field]);
    if (missing.length) {
      return {
        status: 400,
        jsonBody: { error: `Missing required field(s): ${missing.join(', ')}` },
      };
    }

    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0 || items.length > MAX_ITEMS_PER_SUBMISSION) {
      return {
        status: 400,
        jsonBody: {
          error: `Submit between 1 and ${MAX_ITEMS_PER_SUBMISSION} claim items.`,
        },
      };
    }

    for (const [index, item] of items.entries()) {
      if (!item.invoiceNumber && !item.poNumber) {
        return {
          status: 400,
          jsonBody: { error: `Claim ${index + 1}: missing invoiceNumber or poNumber.` },
        };
      }
    }

    const { accountNumber, description, photoBase64 } = body;

    try {
      // Processed sequentially, not in parallel — the daily claim cap needs
      // to see each item's submission before evaluating the next one.
      const results = [];
      for (const item of items) {
        const result = await evaluateClaim(
          {
            accountNumber,
            description,
            photoBase64,
            invoiceNumber: item.invoiceNumber,
            poNumber: item.poNumber,
            styleName: item.styleName,
            color: item.color,
          },
          context
        );
        const message = await draftCustomerMessage(result, context);

        results.push({
          identifier: item.invoiceNumber
            ? `Invoice ${item.invoiceNumber}`
            : `PO ${item.poNumber}`,
          outcome: result.outcome, // "approved" | "offer" | "escalate"
          message,
          details: result.details,
        });
      }

      return { status: 200, jsonBody: { results } };
    } catch (err) {
      context.error('submitClaim failed', err);
      return {
        status: 500,
        jsonBody: {
          error:
            'Something went wrong processing this claim. Please try again or contact customer relations.',
        },
      };
    }
  },
});
