import { MongoMemoryServer } from "mongodb-memory-server";

let mongod: MongoMemoryServer | undefined;

export async function setup() {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = "test-secret-at-least-sixteen-characters";
  process.env.CORS_ORIGIN = "http://localhost:3000";
  delete process.env.REDIS_URL;
}

export async function teardown() {
  if (mongod) await mongod.stop();
}
