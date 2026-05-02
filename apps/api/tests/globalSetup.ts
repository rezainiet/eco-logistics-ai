import { MongoMemoryReplSet } from "mongodb-memory-server";

let mongod: MongoMemoryReplSet | undefined;

export async function setup() {
  // Replica set (single node) — required because the order-create flow uses
  // a multi-document Mongo transaction for exactly-once semantics. Standalone
  // mongod instances reject `session.startTransaction()`, so production parity
  // here also catches transaction-misuse bugs in CI.
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = "test-secret-at-least-sixteen-characters";
  process.env.CORS_ORIGIN = "http://localhost:3001";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_sprintB_secret";
  // 32-byte base64 key — required by crypto.ts in every env after DS-b
  process.env.COURIER_ENC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  delete process.env.REDIS_URL;
}

export async function teardown() {
  if (mongod) await mongod.stop();
}
