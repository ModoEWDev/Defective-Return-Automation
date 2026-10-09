const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = 'WarrantyClaims';
// Reuses the storage account every Function App already has (AzureWebJobsStorage)
// rather than provisioning a separate one just for this.
const connectionString = process.env.AzureWebJobsStorage;

let tableClientPromise;

async function getTableClient() {
  if (!tableClientPromise) {
    tableClientPromise = (async () => {
      const client = TableClient.fromConnectionString(connectionString, TABLE_NAME);
      await client.createTable().catch((err) => {
        if (err.statusCode !== 409) throw err; // 409 = table already exists
      });
      return client;
    })();
  }
  return tableClientPromise;
}

function todayPartitionKey(accountNumber) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return `${accountNumber}_${today}`;
}

async function getClaimCountToday(accountNumber) {
  const client = await getTableClient();
  const partitionKey = todayPartitionKey(accountNumber);
  let count = 0;
  const entities = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${partitionKey}'` },
  });
  for await (const _ of entities) count++;
  return count;
}

async function recordClaimSubmission(accountNumber) {
  const client = await getTableClient();
  const partitionKey = todayPartitionKey(accountNumber);
  await client.createEntity({
    partitionKey,
    rowKey: `${Date.now()}`,
    submittedAt: new Date().toISOString(),
  });
}

module.exports = { getClaimCountToday, recordClaimSubmission };
