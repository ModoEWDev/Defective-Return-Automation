const { app } = require('@azure/functions');
const { evaluateClaim } = require('../lib/rules');
const { getCustomerMessage, isPhotoOfEyewear } = require('../lib/claude');

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
      if (!item.documentNumber) {
        return {
          status: 400,
          jsonBody: { error: `Claim ${index + 1}: missing documentNumber.` },
        };
      }
    }

    const { accountNumber, description, photoBase64, photoMimeType } = body;

    const SUPPORTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!SUPPORTED_PHOTO_TYPES.includes(photoMimeType)) {
      return {
        status: 400,
        jsonBody: {
          error:
            "Unfortunately, we can't accept this type of file — we only accept JPEG, PNG, GIF, or WEBP. Please resubmit your claim using one of those file types.",
        },
      };
    }

    const photoLooksLikeEyewear = await isPhotoOfEyewear(photoBase64, photoMimeType, context);
    if (!photoLooksLikeEyewear) {
      return {
        status: 400,
        jsonBody: {
          error:
            "We couldn't recognize this photo as a frame or clip. Please upload a clear photo of the item and submit your claim again.",
        },
      };
    }

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
            documentNumber: item.documentNumber,
            styleName: item.styleName,
            color: item.color,
            productType: item.productType,
          },
          context
        );
        const message = getCustomerMessage(result);

        results.push({
          identifier: `Document ${item.documentNumber}`,
          outcome: result.outcome, // "approved" | "offer" | "escalate" | "invalid"
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
