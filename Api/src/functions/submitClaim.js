const { app } = require('@azure/functions');
const { evaluateClaim } = require('../lib/rules');
const { draftCustomerMessage } = require('../lib/claude');

const ALWAYS_REQUIRED_FIELDS = ['accountNumber', 'sku', 'description', 'photoBase64'];

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
    if (!body.invoiceNumber && !body.poNumber) {
      missing.push('invoiceNumber or poNumber');
    }
    if (missing.length) {
      return {
        status: 400,
        jsonBody: { error: `Missing required field(s): ${missing.join(', ')}` },
      };
    }

    const { invoiceNumber, poNumber, accountNumber, sku, description, photoBase64 } = body;

    try {
      const result = await evaluateClaim(
        { invoiceNumber, poNumber, accountNumber, sku, description, photoBase64 },
        context
      );
      const message = await draftCustomerMessage(result, context);

      return {
        status: 200,
        jsonBody: {
          outcome: result.outcome, // "approved" | "offer" | "escalate"
          message,
          details: result.details,
        },
      };
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
